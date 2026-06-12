import {
	FileSystemAdapter,
	ItemView,
	MarkdownRenderer,
	Menu,
	Notice,
	PaneType,
	TFile,
	WorkspaceLeaf,
	setIcon,
} from "obsidian";
import { runCapture, runGit } from "./git";
import type PiAgentPlugin from "./main";
import { AgentBackend, BackendEvent, BackendModel, NormalizedStats, PermissionRequest } from "./backend";
import { PiBackend } from "./pi-backend";
import { ClaudeBackend } from "./claude-backend";
import { ExtensionUIRequest, ThinkingLevel } from "./rpc-types";
import { showUIDialog } from "./ui-dialog";

export const PI_VIEW_TYPE = "pi-agent-chat";

interface ToolBlock {
	root: HTMLElement;
	header: HTMLElement;
	body: HTMLElement;
	titleEl: HTMLElement;
}

export class PiChatView extends ItemView {
	private backend: AgentBackend | null = null;
	private models: BackendModel[] = [];

	// DOM
	private transcriptEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private quickBarEl!: HTMLElement;
	private contextEl!: HTMLElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private engineSelect!: HTMLSelectElement;
	private modelSelect!: HTMLSelectElement;
	private thinkingSelect!: HTMLSelectElement;

	// Streaming render state
	private currentTextEl: HTMLElement | null = null;
	private currentText = "";
	private currentThinkingEl: HTMLElement | null = null;
	private currentThinking = "";
	private toolBlocks = new Map<string, ToolBlock>();
	private rafPending = false;
	private streaming = false;
	private workingEl: HTMLElement | null = null;

	// Page (and optional selection) attached via the "ask about" context menu,
	// prepended to the next message.
	private pendingContext: { pagePath: string; selection?: string } | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: PiAgentPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PI_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Pi Agent";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("pi-agent-view");
		this.buildHeader();
		this.transcriptEl = this.contentEl.createDiv({ cls: "pi-transcript" });
		this.quickBarEl = this.contentEl.createDiv({ cls: "pi-quickbar" });
		this.renderQuickPrompts();
		this.contextEl = this.contentEl.createDiv({ cls: "pi-context" });
		this.contextEl.hide();
		this.buildInput();
		await this.connect();
	}

	async onClose(): Promise<void> {
		this.teardownBackend();
	}

	// ---------------------------------------------------------------- layout

	private buildHeader(): void {
		const header = this.contentEl.createDiv({ cls: "pi-header" });

		this.engineSelect = header.createEl("select", { cls: "pi-select pi-engine-select" });
		this.engineSelect.createEl("option", { text: "pi", value: "pi" });
		this.engineSelect.createEl("option", { text: "Claude Code", value: "claude" });
		this.engineSelect.value = this.plugin.settings.engine;
		this.engineSelect.addEventListener("change", () => this.onEngineChange());

		this.modelSelect = header.createEl("select", { cls: "pi-select pi-model-select" });
		this.modelSelect.createEl("option", { text: "Loading models…", value: "" });
		this.modelSelect.addEventListener("change", () => this.onModelChange());

		this.thinkingSelect = header.createEl("select", { cls: "pi-select pi-thinking-select" });
		for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
			this.thinkingSelect.createEl("option", { text: `🧠 ${lvl}`, value: lvl });
		}
		this.thinkingSelect.value = this.plugin.settings.thinking;
		this.thinkingSelect.addEventListener("change", async () => {
			if (this.backend?.running) await this.backend.setThinking(this.thinkingSelect.value as ThinkingLevel);
		});

		const spacer = header.createDiv({ cls: "pi-header-spacer" });
		spacer.style.flex = "1";

		const newBtn = header.createEl("button", { cls: "pi-icon-btn", attr: { "aria-label": "New session" } });
		setIcon(newBtn, "plus");
		newBtn.addEventListener("click", () => this.startNewSession());

		this.stopBtn = header.createEl("button", { cls: "pi-icon-btn pi-stop-btn", attr: { "aria-label": "Stop" } });
		setIcon(this.stopBtn, "square");
		this.stopBtn.hide();
		this.stopBtn.addEventListener("click", () => this.backend?.abort());

		if (this.plugin.isGitRepo()) {
			const gitBtn = header.createEl("button", { cls: "pi-icon-btn", attr: { "aria-label": "Git" } });
			setIcon(gitBtn, "git-branch");
			gitBtn.addEventListener("click", (e) => this.openGitMenu(e));
		}

		this.statusEl = this.contentEl.createDiv({ cls: "pi-status" });
	}

	private async onEngineChange(): Promise<void> {
		const engine = this.engineSelect.value as "pi" | "claude";
		this.plugin.settings.engine = engine;
		await this.plugin.saveSettings();
		this.teardownBackend();
		this.transcriptEl.empty();
		await this.connect();
	}

	// ------------------------------------------------------------------- git

	private openGitMenu(evt: MouseEvent): void {
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Commit all changes…").setIcon("check").onClick(() => void this.gitCommit(false)));
		menu.addItem((i) => i.setTitle("Commit & push…").setIcon("git-branch").onClick(() => void this.gitCommit(true)));
		menu.addItem((i) => i.setTitle("Push").setIcon("upload").onClick(() => void this.gitPush()));
		menu.showAtMouseEvent(evt);
	}

	private async gitCommit(alsoPush: boolean): Promise<void> {
		const cwd = this.plugin.getWorkingDir();
		if (!cwd) return;

		const status = await runGit(cwd, ["status", "--porcelain"]);
		if (status.code !== 0) {
			new Notice(`git: ${status.stderr.trim() || "status failed"}`);
			return;
		}
		if (!status.stdout.trim()) {
			new Notice("No changes to commit.");
			if (alsoPush) await this.gitPush();
			return;
		}

		// Stage everything first so the suggested message covers all changes.
		this.setStatus("Staging changes…");
		const add = await runGit(cwd, ["add", "-A"]);
		if (add.code !== 0) {
			new Notice(`git add failed: ${add.stderr.trim()}`);
			this.setStatus("Commit failed", true);
			return;
		}

		let suggestion = "";
		if (this.plugin.settings.gitSuggestCommitMessage) {
			this.setStatus("Suggesting commit message…");
			suggestion = await this.suggestCommitMessage(cwd);
		}

		const req: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: "git-commit",
			method: "editor",
			title: "Commit message",
			prefill: suggestion,
			placeholder: "Describe the change",
		};
		const answer = await showUIDialog(this.app, req);
		if (answer.cancelled) {
			this.setStatus("Commit cancelled (changes left staged).");
			return;
		}
		const msg = (typeof answer.value === "string" && answer.value.trim()) || suggestion.trim() || "Update from Obsidian";

		this.setStatus("Committing…");
		const commit = await runGit(cwd, ["commit", "-m", msg]);
		if (commit.code !== 0) {
			new Notice(`git commit failed: ${commit.stderr.trim() || commit.stdout.trim()}`);
			this.setStatus("Commit failed", true);
			return;
		}
		new Notice("Committed.");
		this.setStatus(commit.stdout.split("\n").find((l) => l.trim()) ?? "Committed.");
		if (alsoPush) await this.gitPush();
	}

	/** Ask the selected engine for a commit message based on the staged diff + AGENTS.md. */
	private async suggestCommitMessage(cwd: string): Promise<string> {
		try {
			const stat = await runGit(cwd, ["diff", "--cached", "--stat"]);
			const diff = await runGit(cwd, ["diff", "--cached"]);
			let changes = `${stat.stdout}\n\n${diff.stdout}`.trim();
			if (changes.length > 6000) changes = changes.slice(0, 6000) + "\n...(truncated)";

			const agents = this.plugin.getAgentsContent();
			const prompt =
				(agents
					? `The repository's AGENTS.md (follow its commit-message format and the language it requires):\n\n${agents}\n\n`
					: "") +
				`Staged git changes:\n\n${changes}\n\n` +
				`Write a git commit message for these changes. Follow the commit-message conventions and the language defined in AGENTS.md. Output ONLY the commit message text — no quotes, no preamble, no code fences.`;

			const out = await this.runEngineOneShot(prompt);
			return this.sanitizeMessage(out);
		} catch {
			return "";
		}
	}

	/** Run the selected engine in non-interactive print mode for a one-shot reply. */
	private async runEngineOneShot(prompt: string): Promise<string> {
		const s = this.plugin.settings;
		const cwd = this.plugin.getWorkingDir();
		if (!cwd) return "";

		let cmd: string;
		let args: string[];
		if (s.engine === "claude") {
			cmd = s.claudePath;
			// A small fast model is plenty for a commit message and keeps the popup snappy.
			args = ["-p", "--output-format", "text", "--model", "haiku"];
		} else {
			cmd = s.piPath;
			args = ["-p", "--no-session", "-nt"];
			if (s.provider) args.push("--provider", s.provider);
			if (s.model) args.push("--model", s.model);
		}
		const res = await runCapture(cmd, args, prompt, cwd, 60_000);
		return res.code === 0 ? res.stdout : "";
	}

	private sanitizeMessage(s: string): string {
		let t = (s || "").trim();
		t = t.replace(/^```[a-zA-Z]*\s*/, "").replace(/```$/, "").trim();
		if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
			t = t.slice(1, -1).trim();
		}
		return t;
	}

	private async gitPush(): Promise<void> {
		const cwd = this.plugin.getWorkingDir();
		if (!cwd) return;
		this.setStatus("Pushing…");
		const res = await runGit(cwd, ["push"]);
		if (res.code !== 0) {
			new Notice(`git push failed: ${res.stderr.trim() || res.stdout.trim() || "push failed"}`);
			this.setStatus("Push failed", true);
			return;
		}
		new Notice("Pushed.");
		this.setStatus("Pushed.");
	}

	private buildInput(): void {
		const wrap = this.contentEl.createDiv({ cls: "pi-input-row" });
		this.inputEl = wrap.createEl("textarea", {
			cls: "pi-input",
			attr: { placeholder: "Ask the agent about your wiki… (Enter to send, Shift+Enter for newline)", rows: "3" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.onSend();
			}
		});
		this.sendBtn = wrap.createEl("button", { cls: "pi-send-btn", text: "Send" });
		this.sendBtn.addEventListener("click", () => this.onSend());
	}

	/** Rebuild the quick-prompt button bar from the plugin's prompt store. */
	reloadPrompts(): void {
		this.renderQuickPrompts();
	}

	private renderQuickPrompts(): void {
		if (!this.quickBarEl) return;
		this.quickBarEl.empty();
		const prompts = this.plugin.promptStore.getAll();
		if (prompts.length === 0) {
			this.quickBarEl.hide();
			return;
		}
		this.quickBarEl.show();
		for (const p of prompts) {
			const btn = this.quickBarEl.createEl("button", { cls: "pi-quick-btn", text: p.label });
			if (p.prompt) btn.setAttribute("aria-label", p.prompt);
			btn.addEventListener("click", () => {
				if (!p.prompt.trim()) {
					new Notice(`Standard prompt "${p.label}" has no text.`);
					return;
				}
				void this.submitMessage(p.prompt);
			});
		}
	}

	// ------------------------------------------------------------- lifecycle

	private async connect(): Promise<void> {
		if (this.backend) return;
		const cwd = this.plugin.getWorkingDir();
		if (!cwd) {
			this.setStatus("Cannot resolve vault path — a local vault is required.", true);
			return;
		}

		const s = this.plugin.settings;
		const engine = s.engine;
		this.engineSelect.value = engine;

		if (engine === "claude") {
			this.backend = new ClaudeBackend({
				claudePath: s.claudePath,
				cwd,
				model: s.claudeModel || "default",
				permissionMode: s.claudePermissionMode,
				agentsFile: this.plugin.getAgentsFile() ?? undefined,
				agentsMode: s.claudeAgentsMode,
			});
		} else {
			this.backend = new PiBackend({
				piPath: s.piPath,
				cwd,
				provider: s.provider || undefined,
				model: s.model || undefined,
				thinking: s.thinking,
				persistSession: s.persistSession,
			});
		}

		const backend = this.backend;
		backend.on("event", (ev: BackendEvent) => this.handleBackendEvent(ev));
		backend.on("dialog", (req: ExtensionUIRequest) => this.handleDialog(req));
		backend.on("permission", (req: PermissionRequest) => this.handlePermission(req));
		backend.on("error", (err: Error) => this.setStatus(`${backend.engineName} error: ${err.message}`, true));
		backend.on("exit", (code: number | null) => {
			this.streaming = false;
			this.hideWorking();
			this.refreshSendState();
			const tail = this.backend?.lastStderr;
			this.setStatus(
				`${backend.engineName} process exited${code != null ? ` (code ${code})` : ""}.${tail ? " " + tail.split("\n").pop() : ""}`,
				true
			);
			this.addReconnectNotice();
		});

		try {
			backend.start();
		} catch (err: any) {
			this.setStatus(`Failed to start ${engine}: ${err?.message ?? err}`, true);
			return;
		}

		this.thinkingSelect.toggle(backend.capabilities.thinking);
		this.setStatus(`Connected · ${engine} · cwd: ${cwd}`);
		await this.loadModels();
		await this.refreshStats();
	}

	private teardownBackend(): void {
		if (this.backend) {
			this.backend.dispose();
			this.backend = null;
		}
	}

	private addReconnectNotice(): void {
		const btn = this.statusEl.createEl("button", { text: "Reconnect", cls: "pi-reconnect-btn" });
		btn.addEventListener("click", async () => {
			this.teardownBackend();
			await this.connect();
		});
	}

	/** Public entry point for the "new session" command. */
	async newSessionCommand(): Promise<void> {
		await this.startNewSession();
	}

	/**
	 * Programmatically run a prompt (used by folder-watch automation). Ensures the
	 * backend is connected, waits briefly for it to come up, then submits.
	 */
	private async ensureRunning(): Promise<void> {
		if (!this.backend) await this.connect();
		for (let i = 0; i < 50 && !this.backend?.running; i++) {
			await new Promise((r) => window.setTimeout(r, 200));
		}
	}

	async runPrompt(text: string): Promise<void> {
		await this.ensureRunning();
		await this.submitMessage(text);
	}

	/**
	 * Open a fresh session and attach a page (and optional selection) as immutable
	 * context shown above the input. The context is prepended to the user's next
	 * message. The agent still has full vault access (it runs in the vault root).
	 */
	async seedContext(pagePath: string, selection?: string): Promise<void> {
		await this.ensureRunning();
		// Only reset if there's already a conversation; a just-opened panel is fresh.
		if (this.transcriptEl.childElementCount > 0) {
			await this.startNewSession();
		}
		const sel = selection ? selection.replace(/\r\n/g, "\n").trim() : undefined;
		this.pendingContext = { pagePath, selection: sel || undefined };
		this.renderPendingContext();
		this.inputEl.value = "";
		this.inputEl.focus();
		this.setStatus(
			sel
				? `Context from ${pagePath} attached — type your question.`
				: `Page ${pagePath} attached — type your question.`
		);
	}

	private renderPendingContext(): void {
		this.contextEl.empty();
		const ctx = this.pendingContext;
		if (!ctx) {
			this.contextEl.hide();
			return;
		}
		this.contextEl.show();

		const head = this.contextEl.createDiv({ cls: "pi-context-head" });
		const icon = head.createSpan({ cls: "pi-context-icon" });
		setIcon(icon, ctx.selection ? "text-quote" : "file-text");
		const pathEl = head.createSpan({ cls: "pi-context-path", text: ctx.pagePath });
		pathEl.setAttribute("aria-label", `Open ${ctx.pagePath}`);
		pathEl.addEventListener("click", () => {
			void this.app.workspace.openLinkText(ctx.pagePath, "", false);
		});
		const clear = head.createEl("button", { cls: "pi-context-clear", attr: { "aria-label": "Remove context" } });
		setIcon(clear, "x");
		clear.addEventListener("click", () => {
			this.pendingContext = null;
			this.renderPendingContext();
		});

		if (ctx.selection) {
			this.contextEl.createDiv({ cls: "pi-context-body", text: ctx.selection });
		}
	}

	private async startNewSession(): Promise<void> {
		if (!this.backend?.running) {
			this.teardownBackend();
			this.transcriptEl.empty();
			await this.connect();
			return;
		}
		await this.backend.newSession();
		this.transcriptEl.empty();
		this.resetStreamState();
		this.setStatus("Started a new session.");
		await this.refreshStats();
	}

	private async loadModels(): Promise<void> {
		if (!this.backend) return;
		try {
			this.models = await this.backend.getModels();
		} catch {
			this.models = [];
		}
		this.modelSelect.empty();
		if (this.models.length === 0) {
			this.modelSelect.createEl("option", { text: "(no models)", value: "" });
			return;
		}
		for (const m of this.models) {
			this.modelSelect.createEl("option", { text: m.label, value: m.key });
		}
		try {
			const active = await this.backend.getActiveModelKey();
			if (active) this.modelSelect.value = active;
		} catch {
			/* ignore */
		}
	}

	private async onModelChange(): Promise<void> {
		if (!this.backend?.running) return;
		const key = this.modelSelect.value;
		if (!key) return;
		const res = await this.backend.setModel(key);
		if (!res.ok) {
			new Notice(`Could not switch model: ${res.error ?? "unknown error"}`);
		} else {
			this.setStatus(`Model: ${this.modelSelect.selectedOptions[0]?.text ?? key}`);
		}
		await this.refreshStats();
	}

	// ---------------------------------------------------------------- sending

	private async onSend(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text) return;
		this.inputEl.value = "";
		await this.submitMessage(text);
	}

	/** Send a message to the agent (used by the input box and quick-prompt buttons). */
	private async submitMessage(text: string): Promise<void> {
		if (!text.trim()) return;
		if (!this.backend?.running) {
			new Notice("The agent is not running. Try Reconnect.");
			return;
		}

		// Fold any attached page/selection context into this message, then clear it.
		let message = text;
		if (this.pendingContext) {
			const ctx = this.pendingContext;
			if (ctx.selection) {
				const quoted = ctx.selection
					.split("\n")
					.map((l) => `> ${l}`)
					.join("\n");
				message = `Regarding \`${ctx.pagePath}\`, this selection:\n\n${quoted}\n\n${text}`;
			} else {
				message = `Regarding the page \`${ctx.pagePath}\`:\n\n${text}`;
			}
			this.pendingContext = null;
			this.renderPendingContext();
		}

		this.appendUserMessage(message);
		this.showWorking();

		try {
			const res = await this.backend.prompt(message, this.streaming);
			if (!res.ok) {
				this.hideWorking();
				if (this.streaming) new Notice(res.error ?? "Message rejected.");
				else this.setStatus(res.error ?? "Prompt rejected.", true);
			}
		} catch (err: any) {
			this.hideWorking();
			this.setStatus(`Send failed: ${err?.message ?? err}`, true);
		}
	}

	// ----------------------------------------------------------- event stream

	private handleBackendEvent(ev: BackendEvent): void {
		switch (ev.type) {
			case "run-start":
				this.streaming = true;
				this.resetStreamState();
				this.showWorking();
				this.refreshSendState();
				break;

			case "text-start":
				this.finalizeThinking();
				this.currentText = "";
				this.currentTextEl = this.newAssistantTextBlock();
				break;
			case "text-delta":
				if (!this.currentTextEl) this.currentTextEl = this.newAssistantTextBlock();
				this.currentText += ev.delta;
				this.scheduleRender();
				break;
			case "text-end":
				if (typeof ev.content === "string") this.currentText = ev.content;
				this.finalizeText();
				break;

			case "thinking-delta":
				if (!this.plugin.settings.showThinking) break;
				if (!this.currentThinkingEl) this.currentThinkingEl = this.newThinkingBlock();
				this.currentThinking += ev.delta;
				this.scheduleRender();
				break;

			case "tool-start":
				this.onToolStart(ev);
				break;
			case "tool-update":
				this.onToolUpdate(ev);
				break;
			case "tool-end":
				this.onToolEnd(ev);
				break;

			case "run-end":
				this.streaming = false;
				this.hideWorking();
				this.finalizeText();
				this.finalizeThinking();
				this.refreshSendState();
				void this.refreshStats();
				break;

			case "error":
				this.hideWorking();
				this.finalizeText();
				this.finalizeThinking();
				this.showErrorBlock(this.formatAssistantError(undefined, ev.message));
				break;

			case "status":
				this.setStatus(ev.text);
				break;
			case "stats":
				this.renderStats(ev.stats);
				break;
			case "notice":
				new Notice(ev.message);
				break;
		}
	}

	/** Turn provider error payloads into a readable, friendly message. */
	private formatAssistantError(reason: string | undefined, raw: string | undefined): string {
		if (reason === "aborted") return "Stopped.";
		let detail = (raw ?? "").trim();
		const jsonStart = detail.indexOf("{");
		if (jsonStart !== -1) {
			try {
				const obj = JSON.parse(detail.slice(jsonStart));
				const msg = obj?.error?.message ?? obj?.message;
				if (typeof msg === "string") detail = msg;
			} catch {
				/* keep raw */
			}
		}
		return detail || "The model returned an error.";
	}

	private showErrorBlock(text: string): void {
		const block = this.appendBlock("pi-msg pi-msg-error");
		block.createDiv({ cls: "pi-error-label", text: "error" });
		block.createDiv({ cls: "pi-error-body", text });
		this.scrollToBottom(true);
	}

	// ---------------------------------------------------------- tool rendering

	private onToolStart(ev: Extract<BackendEvent, { type: "tool-start" }>): void {
		const block = this.newToolBlock(ev.name, ev.args);
		this.toolBlocks.set(ev.id, block);
	}

	private onToolUpdate(ev: Extract<BackendEvent, { type: "tool-update" }>): void {
		const block = this.toolBlocks.get(ev.id);
		if (!block) return;
		if (ev.text) this.setToolBody(block, ev.text, false);
	}

	private onToolEnd(ev: Extract<BackendEvent, { type: "tool-end" }>): void {
		const block = this.toolBlocks.get(ev.id);
		if (!block) return;
		this.setToolBody(block, ev.text || (ev.isError ? "(error)" : "(done)"), ev.isError);
		block.root.toggleClass("pi-tool-error", ev.isError);
		const badge = block.titleEl.querySelector(".pi-tool-status");
		if (badge) badge.setText(ev.isError ? "error" : "done");
	}

	// --------------------------------------------------------- DOM builders

	/** Append a transcript block, keeping it above the working indicator if shown. */
	private appendBlock(cls: string): HTMLElement {
		const el = this.transcriptEl.createDiv({ cls });
		if (this.workingEl) this.transcriptEl.insertBefore(el, this.workingEl);
		return el;
	}

	/** Show the animated "agent is working" indicator at the bottom of the transcript. */
	private showWorking(): void {
		if (!this.workingEl) {
			this.workingEl = this.transcriptEl.createDiv({ cls: "pi-working", attr: { "aria-label": "Working" } });
			for (let i = 0; i < 3; i++) this.workingEl.createSpan({ cls: "pi-working-dot" });
		}
		this.transcriptEl.appendChild(this.workingEl); // keep it last
		this.scrollToBottom();
	}

	private hideWorking(): void {
		this.workingEl?.remove();
		this.workingEl = null;
	}

	private appendUserMessage(text: string): void {
		const block = this.appendBlock("pi-msg pi-msg-user");
		const body = block.createDiv({ cls: "pi-msg-body" });
		this.renderMarkdownInto(body, text);
		this.scrollToBottom(true);
	}

	private newAssistantTextBlock(): HTMLElement {
		const block = this.appendBlock("pi-msg pi-msg-assistant");
		const body = block.createDiv({ cls: "pi-msg-body" });
		this.scrollToBottom();
		return body;
	}

	private newThinkingBlock(): HTMLElement {
		const block = this.appendBlock("pi-msg pi-msg-thinking");
		block.createDiv({ cls: "pi-thinking-label", text: "thinking" });
		const body = block.createEl("pre", { cls: "pi-thinking-body" });
		this.scrollToBottom();
		return body;
	}

	private newToolBlock(toolName: string, args: any): ToolBlock {
		const root = this.appendBlock("pi-tool");
		const header = root.createDiv({ cls: "pi-tool-header" });
		const titleEl = header.createDiv({ cls: "pi-tool-title" });
		const icon = titleEl.createSpan({ cls: "pi-tool-icon" });
		setIcon(icon, this.toolIcon(toolName));
		titleEl.createSpan({ cls: "pi-tool-name", text: toolName });
		const argEl = titleEl.createSpan({ cls: "pi-tool-arg", text: this.summarizeArgs(toolName, args) });
		const full = this.fullArgs(args);
		if (full) argEl.setAttribute("title", full);
		titleEl.createSpan({ cls: "pi-tool-status", text: "running" });

		const body = root.createEl("pre", { cls: "pi-tool-body" });
		body.hide();

		header.addEventListener("click", () => {
			if (body.isShown()) body.hide();
			else body.show();
		});
		this.scrollToBottom();
		return { root, header, body, titleEl };
	}

	private setToolBody(block: ToolBlock, text: string, isError: boolean): void {
		const trimmed = text.length > 20000 ? text.slice(0, 20000) + "\n… (truncated)" : text;
		block.body.setText(trimmed);
		block.body.toggleClass("pi-tool-body-error", isError);
	}

	private toolIcon(name: string): string {
		switch (name) {
			case "read":
			case "Read":
				return "file-text";
			case "write":
			case "Write":
				return "file-plus";
			case "edit":
			case "Edit":
				return "pencil";
			case "bash":
			case "Bash":
				return "terminal";
			case "grep":
			case "Grep":
				return "search";
			case "find":
			case "ls":
			case "Glob":
			case "LS":
				return "folder";
			default:
				return "wrench";
		}
	}

	private summarizeArgs(toolName: string, args: any): string {
		if (!args || typeof args !== "object") return "";
		if (typeof args.path === "string") return args.path;
		if (typeof args.file === "string") return args.file;
		if (typeof args.file_path === "string") return args.file_path;
		if (typeof args.command === "string") return this.firstLine(args.command);
		if (typeof args.pattern === "string") return this.firstLine(args.pattern);
		const keys = Object.keys(args);
		return keys.length ? `${keys[0]}=…` : "";
	}

	/** Collapse a multi-line value to its first non-empty line, marking the rest. */
	private firstLine(value: string): string {
		const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		if (lines.length === 0) return "";
		return lines.length > 1 ? `${lines[0]} …` : lines[0];
	}

	/** Full argument text for the hover tooltip. */
	private fullArgs(args: any): string {
		if (!args || typeof args !== "object") return "";
		if (typeof args.command === "string") return args.command;
		if (typeof args.path === "string") return args.path;
		if (typeof args.file_path === "string") return args.file_path;
		if (typeof args.pattern === "string") return args.pattern;
		try {
			return JSON.stringify(args, null, 2);
		} catch {
			return "";
		}
	}

	// ----------------------------------------------------------- render loop

	private scheduleRender(): void {
		if (this.rafPending) return;
		this.rafPending = true;
		window.requestAnimationFrame(() => {
			this.rafPending = false;
			if (this.currentTextEl) {
				this.renderMarkdownInto(this.currentTextEl, this.currentText);
			}
			if (this.currentThinkingEl) {
				this.currentThinkingEl.setText(this.currentThinking);
			}
			this.scrollToBottom();
		});
	}

	private renderMarkdownInto(el: HTMLElement, markdown: string, decorate = false): void {
		el.empty();
		void MarkdownRenderer.render(this.app, markdown, el, "", this).then(() => {
			// Decorate options before linkify so option paths don't become page links.
			if (decorate) this.decorateOptions(el);
			this.linkifyPaths(el);
		});
	}

	/**
	 * If an assistant message poses a choice — a trailing question mark plus an
	 * ordered list of 2+ items — turn those list items into clickable option chips
	 * (visually distinct from wiki links). Clicking one sends it as the reply.
	 */
	private decorateOptions(root: HTMLElement): void {
		if (!root.closest(".pi-msg-assistant")) return;
		if (!(root.textContent ?? "").trim().endsWith("?")) return;

		const lists = root.querySelectorAll("ol");
		if (lists.length === 0) return;
		const ol = lists[lists.length - 1] as HTMLElement;
		const items = Array.from(ol.children).filter((c) => c.tagName === "LI") as HTMLElement[];
		if (items.length < 2) return;

		ol.classList.add("pi-options");
		for (const li of items) {
			li.classList.add("pi-option");
			li.setAttribute("role", "button");
			li.setAttribute("tabindex", "0");
			const reply = (li.textContent ?? "").trim();
			const choose = () => this.chooseOption(ol, li, reply);
			li.addEventListener("click", choose);
			li.addEventListener("keydown", (e) => {
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					choose();
				}
			});
		}
	}

	private chooseOption(ol: HTMLElement, li: HTMLElement, reply: string): void {
		if (ol.classList.contains("pi-options-answered")) return;
		ol.classList.add("pi-options-answered");
		li.classList.add("pi-option-selected");
		void this.submitMessage(reply);
	}

	// ------------------------------------------------- vault page path linking

	/**
	 * Walk the rendered markdown and turn references to existing vault pages
	 * (e.g. `wiki/agentic-development/index.md`) into clickable links that open
	 * the page in the main document area. Paths that don't resolve to a real
	 * file are left as plain text.
	 */
	private linkifyPaths(root: HTMLElement): void {
		const pathRe = /[A-Za-z0-9_.\-/\\]+\.(?:md|markdown)\b/g;

		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (node: Node) => {
				const parent = (node as Text).parentElement;
				if (!parent) return NodeFilter.FILTER_REJECT;
				if (parent.closest("pre, a, .pi-page-link, .pi-option")) return NodeFilter.FILTER_REJECT;
				if (!node.nodeValue || !/\.(md|markdown)\b/.test(node.nodeValue)) {
					return NodeFilter.FILTER_REJECT;
				}
				return NodeFilter.FILTER_ACCEPT;
			},
		});

		const targets: Text[] = [];
		for (let n = walker.nextNode(); n; n = walker.nextNode()) targets.push(n as Text);

		for (const textNode of targets) {
			const text = textNode.nodeValue ?? "";
			pathRe.lastIndex = 0;
			let match: RegExpExecArray | null;
			let lastIndex = 0;
			let found = false;
			const frag = document.createDocumentFragment();

			while ((match = pathRe.exec(text)) !== null) {
				const raw = match[0];
				const dest = this.resolvePagePath(raw);
				if (!dest) continue;
				found = true;
				if (match.index > lastIndex) {
					frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
				}
				frag.appendChild(this.createPageLink(raw, dest));
				lastIndex = match.index + raw.length;
			}

			if (!found) continue;
			if (lastIndex < text.length) {
				frag.appendChild(document.createTextNode(text.slice(lastIndex)));
			}
			textNode.parentNode?.replaceChild(frag, textNode);
		}
	}

	private createPageLink(label: string, dest: TFile): HTMLAnchorElement {
		const a = document.createElement("a");
		a.className = "pi-page-link";
		a.textContent = label;
		a.setAttribute("href", dest.path);
		a.setAttribute("aria-label", dest.path);
		a.addEventListener("click", (e) => {
			e.preventDefault();
			const newLeaf: PaneType | boolean = e.ctrlKey || e.metaKey ? "tab" : false;
			void this.app.workspace.openLinkText(dest.path, "", newLeaf);
		});
		a.addEventListener("auxclick", (e) => {
			if (e.button === 1) {
				e.preventDefault();
				void this.app.workspace.openLinkText(dest.path, "", "tab");
			}
		});
		return a;
	}

	/** Resolve a path the agent printed to an existing vault TFile, or null. */
	private resolvePagePath(raw: string): TFile | null {
		let p = raw.trim().replace(/\\/g, "/").replace(/^\.\//, "");

		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			const base = adapter.getBasePath().replace(/\\/g, "/").replace(/\/+$/, "");
			if (base && p.toLowerCase().startsWith(base.toLowerCase() + "/")) {
				p = p.slice(base.length + 1);
			}
		}

		const sub = this.plugin.settings.workingDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (sub && !p.toLowerCase().startsWith(sub.toLowerCase() + "/")) {
			p = `${sub}/${p}`;
		}

		const dest = this.app.metadataCache.getFirstLinkpathDest(p, "");
		return dest instanceof TFile ? dest : null;
	}

	// ---------------------------------------------------------- finalization

	private finalizeText(): void {
		if (this.currentTextEl) {
			this.renderMarkdownInto(this.currentTextEl, this.currentText, true);
		}
		this.currentTextEl = null;
		this.currentText = "";
		this.scrollToBottom();
	}

	private finalizeThinking(): void {
		if (this.currentThinkingEl) this.currentThinkingEl.setText(this.currentThinking);
		this.currentThinkingEl = null;
		this.currentThinking = "";
	}

	private resetStreamState(): void {
		this.currentTextEl = null;
		this.currentText = "";
		this.currentThinkingEl = null;
		this.currentThinking = "";
		this.toolBlocks.clear();
		this.hideWorking();
	}

	// ------------------------------------------------------- dialogs / perms

	/** pi extension UI dialog (select/confirm/input/editor/notify/...). */
	private async handleDialog(req: ExtensionUIRequest): Promise<void> {
		switch (req.method) {
			case "notify":
				new Notice(`pi: ${req.message ?? ""}`);
				return;
			case "set_editor_text":
				this.inputEl.value = String((req as any).text ?? "");
				return;
			case "setStatus":
			case "setWidget":
			case "setTitle":
				return;
		}

		const policy = this.plugin.settings.dialogPolicy;
		if (policy !== "ask") {
			this.backend?.respondDialog(this.autoAnswer(req, policy));
			return;
		}
		const answer = await showUIDialog(this.app, req);
		this.backend?.respondDialog(answer);
	}

	private autoAnswer(req: ExtensionUIRequest, policy: "allow" | "block"): Record<string, unknown> {
		const allow = policy === "allow";
		switch (req.method) {
			case "confirm":
				return { id: req.id, confirmed: allow };
			case "select": {
				const opts = req.options ?? [];
				if (allow && opts.length > 0) return { id: req.id, value: opts[0] };
				return { id: req.id, cancelled: true };
			}
			default:
				return { id: req.id, cancelled: true };
		}
	}

	/** Claude tool-permission request — honor the dialog policy. */
	private async handlePermission(req: PermissionRequest): Promise<void> {
		const policy = this.plugin.settings.dialogPolicy;
		if (policy === "allow") {
			this.backend?.respondPermission(req.id, { allow: true }, req.input);
			return;
		}
		if (policy === "block") {
			this.backend?.respondPermission(req.id, { allow: false });
			return;
		}
		const synthetic: ExtensionUIRequest = {
			type: "extension_ui_request",
			id: req.id,
			method: "confirm",
			title: `Allow ${req.toolName}?`,
			message: this.describeToolInput(req.input),
		};
		const answer = await showUIDialog(this.app, synthetic);
		this.backend?.respondPermission(req.id, { allow: answer.confirmed === true }, req.input);
	}

	private describeToolInput(input: unknown): string {
		if (!input || typeof input !== "object") return "";
		const o = input as Record<string, unknown>;
		if (typeof o.command === "string") return o.command;
		if (typeof o.file_path === "string") return o.file_path;
		if (typeof o.path === "string") return o.path;
		try {
			return JSON.stringify(o);
		} catch {
			return "";
		}
	}

	// ---------------------------------------------------------------- status

	private async refreshStats(): Promise<void> {
		if (!this.backend?.running) return;
		try {
			const stats = await this.backend.getStats();
			if (stats) this.renderStats(stats);
		} catch {
			/* ignore */
		}
	}

	private renderStats(d: NormalizedStats): void {
		const parts: string[] = [];
		if (d.contextPercent != null) parts.push(`ctx ${d.contextPercent}%`);
		if (typeof d.cost === "number") parts.push(`$${d.cost.toFixed(4)}`);
		if (d.tokensTotal) parts.push(`${d.tokensTotal.toLocaleString()} tok`);
		if (parts.length) this.setStatus(parts.join(" · "));
	}

	private setStatus(text: string, isError = false): void {
		this.statusEl.empty();
		this.statusEl.setText(text);
		this.statusEl.toggleClass("pi-status-error", isError);
	}

	private refreshSendState(): void {
		if (this.streaming) {
			this.stopBtn.show();
			this.sendBtn.setText("Steer");
		} else {
			this.stopBtn.hide();
			this.sendBtn.setText("Send");
		}
	}

	private scrollToBottom(force = false): void {
		const el = this.transcriptEl;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
		if (force || nearBottom) el.scrollTop = el.scrollHeight;
	}
}
