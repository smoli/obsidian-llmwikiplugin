import {
	FileSystemAdapter,
	ItemView,
	MarkdownRenderer,
	Menu,
	Notice,
	PaneType,
	TFile,
	WorkspaceLeaf,
	normalizePath,
	setIcon,
} from "obsidian";
import { runCapture, runGit } from "./git";
import type LlmAgentPlugin from "./main";
import { AgentBackend, BackendEvent, BackendModel, NormalizedStats, PermissionRequest } from "./backend";
import { SessionRuntime, DebugLogEntry } from "./session-runtime";
import { ResponseEnvelope, parseResponseEnvelopes } from "./response-format";
import { ExtensionUIRequest, ThinkingLevel } from "./rpc-types";
import { SavedSession, SessionMessage, newSessionId } from "./sessions";
import { showUIDialog } from "./ui-dialog";

export const VIEW_TYPE = "llm-agent-chat";

/** Best-effort human-readable text from an unknown thrown value. */
function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}

interface ToolBlock {
	root: HTMLElement;
	header: HTMLElement;
	body: HTMLElement;
	titleEl: HTMLElement;
}

/** "5s" / "12m 49s" / "1h 03m". */
function formatDuration(totalSec: number): string {
	if (totalSec < 60) return `${totalSec}s`;
	const m = Math.floor(totalSec / 60);
	const s = totalSec % 60;
	if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
	const h = Math.floor(m / 60);
	return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Compact token count: "920" / "13.4k" / "1.2M". */
function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	const k = n / 1000;
	if (k < 100) return `${k.toFixed(1)}k`;
	if (k < 1000) return `${Math.round(k)}k`;
	return `${(n / 1e6).toFixed(1)}M`;
}

export class LlmChatView extends ItemView {
	// The view renders the active session's runtime; the runtime owns the backend.
	private runtime: SessionRuntime | null = null;
	private get backend(): AgentBackend | null {
		return this.runtime?.backend ?? null;
	}
	private get structuredResponse(): boolean {
		return this.runtime?.structuredResponse ?? false;
	}
	private models: BackendModel[] = [];

	// DOM
	private mainEl!: HTMLElement;
	private sidebarEl!: HTMLElement;
	private sessionListEl!: HTMLElement;
	private configEl!: HTMLElement;
	private transcriptEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private quickBarEl!: HTMLElement;
	private contextEl!: HTMLElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private newBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private statusMsgEl!: HTMLElement;
	private statusModelEl!: HTMLElement;
	private thinkingField!: HTMLElement;
	private engineSelect!: HTMLSelectElement;
	private modelSelect!: HTMLSelectElement;
	private thinkingSelect!: HTMLSelectElement;
	private personaSelect!: HTMLSelectElement;

	// Streaming render state
	private currentTextEl: HTMLElement | null = null;
	private currentText = "";
	private currentThinkingEl: HTMLElement | null = null;
	private currentThinking = "";
	private toolBlocks = new Map<string, ToolBlock>();
	private rafPending = false;
	private streaming = false;
	private workingEl: HTMLElement | null = null;
	// Working-indicator live meta (elapsed time + token count) for the current run.
	private runStartMs = 0;
	private runTokens = 0;
	private workingTimer: number | null = null;
	private statsPolling = false;
	// When tool-call blocks are hidden, the busy indicator names the active tool.
	// It persists until the next tool starts or the model emits text.
	private currentToolLabel = "";

	// Page (and optional selection) attached via the "ask about" context menu,
	// prepended to the next message.
	private pendingContext: { pagePath: string; selection?: string } | null = null;
	// True when the chip came from auto-attach (so it may be auto-removed on deselect).
	private pendingContextAuto = false;

	// The active session; its transcript is the live conversation record (user +
	// assistant text only, used for saving and for restoring on session switch).
	private session!: SavedSession;
	// Where this conversation was first saved, so re-saving updates the same file.
	private savedChatPath: string | null = null;
	private savedChatStamp: { date: string; time: string } | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: LlmAgentPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	getDisplayText(): string {
		return "STS-LLM Wiki";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("llm-agent-view");

		// Restore the last active session (resumes its conversation) if it still
		// exists; otherwise start fresh. Persona/engine follow the restored session.
		const lastId = this.plugin.sessionStore.getActiveId();
		const restored = lastId ? this.plugin.sessionStore.get(lastId) : undefined;
		this.session = restored ?? this.makeSession();
		if (restored) {
			this.plugin.settings.engine = restored.engine;
			this.plugin.settings.selectedPersona = restored.persona;
		}

		// Two columns: a session sidebar and the chat itself.
		this.sidebarEl = this.contentEl.createDiv({ cls: "llm-sidebar" });
		this.mainEl = this.contentEl.createDiv({ cls: "llm-main" });
		this.buildSidebar();
		this.applySidebarState();

		this.buildHeader();
		this.transcriptEl = this.mainEl.createDiv({ cls: "llm-transcript" });
		this.quickBarEl = this.mainEl.createDiv({ cls: "llm-quickbar" });
		this.renderQuickPrompts();
		this.contextEl = this.mainEl.createDiv({ cls: "llm-context" });
		this.contextEl.hide();
		this.buildInput();
		if (restored) this.renderTranscriptFromSession();
		this.renderSessionList();
		await this.connect();
	}

	async onClose(): Promise<void> {
		void this.plugin.sessionStore.flush();
		this.stopWorkingTimer();
		// Keep a streaming session warm so reopening the panel re-attaches to it.
		this.leaveCurrentRuntime();
	}

	// ---------------------------------------------------------------- layout

	private buildHeader(): void {
		const header = this.mainEl.createDiv({ cls: "llm-header" });

		// Sidebar toggle sits at the far left, right next to the sidebar it controls.
		const sessionsBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Toggle sessions sidebar" } });
		setIcon(sessionsBtn, "panel-left");
		this.registerDomEvent(sessionsBtn, "click", () => this.toggleSidebar());

		// Engine / model / thinking live in a collapsible config panel, opened here.
		const configBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Engine & model settings" } });
		setIcon(configBtn, "sliders-horizontal");
		this.registerDomEvent(configBtn, "click", () => this.toggleConfig());

		this.personaSelect = header.createEl("select", { cls: "llm-select llm-persona-select" });
		this.registerDomEvent(this.personaSelect, "change", () => this.onPersonaChange());
		this.renderPersonaSelect();

		header.createDiv({ cls: "llm-header-spacer" });

		this.newBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "New session" } });
		setIcon(this.newBtn, "plus");
		this.registerDomEvent(this.newBtn, "click", () => this.startNewSession());

		const saveBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Save chat as Markdown" } });
		setIcon(saveBtn, "save");
		this.registerDomEvent(saveBtn, "click", () => this.saveChat());

		const debugBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Export debug log (tool calls + payloads)" } });
		setIcon(debugBtn, "bug");
		this.registerDomEvent(debugBtn, "click", () => this.exportDebugLog());

		this.stopBtn = header.createEl("button", { cls: "llm-icon-btn llm-stop-btn", attr: { "aria-label": "Stop" } });
		setIcon(this.stopBtn, "square");
		this.stopBtn.hide();
		this.registerDomEvent(this.stopBtn, "click", () => this.backend?.abort());

		if (this.plugin.isGitRepo()) {
			const gitBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Git" } });
			setIcon(gitBtn, "git-branch");
			this.registerDomEvent(gitBtn, "click", (e) => this.openGitMenu(e));
		}

		this.buildConfigPanel();
		this.statusEl = this.mainEl.createDiv({ cls: "llm-status" });
		// A transient message on the left, the persistent engine · model on the right.
		this.statusMsgEl = this.statusEl.createSpan({ cls: "llm-status-msg" });
		this.statusModelEl = this.statusEl.createSpan({ cls: "llm-status-model" });
	}

	/** Collapsible panel holding the engine / model / thinking selectors. */
	private buildConfigPanel(): void {
		this.configEl = this.mainEl.createDiv({ cls: "llm-config" });
		this.configEl.hide();

		const engineField = this.configEl.createDiv({ cls: "llm-config-field" });
		engineField.createSpan({ cls: "llm-config-label", text: "Engine" });
		this.engineSelect = engineField.createEl("select", { cls: "llm-select llm-engine-select" });
		this.engineSelect.createEl("option", { text: "pi", value: "pi" });
		this.engineSelect.createEl("option", { text: "Claude Code", value: "claude" });
		this.engineSelect.createEl("option", { text: "OpenAI", value: "openai" });
		this.engineSelect.value = this.plugin.settings.engine;
		this.registerDomEvent(this.engineSelect, "change", () => this.onEngineChange());

		const modelField = this.configEl.createDiv({ cls: "llm-config-field" });
		modelField.createSpan({ cls: "llm-config-label", text: "Model" });
		this.modelSelect = modelField.createEl("select", { cls: "llm-select llm-model-select" });
		this.modelSelect.createEl("option", { text: "Loading models…", value: "" });
		this.registerDomEvent(this.modelSelect, "change", () => this.onModelChange());

		this.thinkingField = this.configEl.createDiv({ cls: "llm-config-field" });
		this.thinkingField.createSpan({ cls: "llm-config-label", text: "Thinking" });
		this.thinkingSelect = this.thinkingField.createEl("select", { cls: "llm-select llm-thinking-select" });
		for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
			this.thinkingSelect.createEl("option", { text: `🧠 ${lvl}`, value: lvl });
		}
		this.thinkingSelect.value = this.plugin.settings.thinking;
		this.registerDomEvent(this.thinkingSelect, "change", async () => {
			if (this.backend?.running) await this.backend.setThinking(this.thinkingSelect.value as ThinkingLevel);
		});

		this.updateConfigVisibility();
	}

	/** Hide controls the active engine doesn't support (e.g. thinking on Claude). */
	private updateConfigVisibility(): void {
		if (!this.thinkingField) return;
		const supportsThinking = this.backend?.capabilities.thinking ?? this.plugin.settings.engine === "pi";
		this.thinkingField.toggle(supportsThinking);
	}

	private toggleConfig(): void {
		this.configEl.toggle(!this.configEl.isShown());
	}

	private async onEngineChange(): Promise<void> {
		if (this.isBusy("switching engine")) {
			this.engineSelect.value = this.plugin.settings.engine;
			return;
		}
		const engine = this.engineSelect.value as "pi" | "claude" | "openai";
		this.plugin.settings.engine = engine;
		await this.plugin.saveSettings();
		// Engine session ids aren't portable across engines, so start a new session.
		await this.startFreshSession();
	}

	/** Populate the persona dropdown from vault-root persona files. */
	private renderPersonaSelect(): void {
		const personas = this.plugin.getPersonas();
		this.personaSelect.empty();
		this.personaSelect.createEl("option", { text: "Default (AGENTS.md)", value: "" });
		for (const p of personas) {
			this.personaSelect.createEl("option", { text: `🎭 ${p.name}`, value: p.path });
		}
		const sel = this.plugin.settings.selectedPersona;
		this.personaSelect.value = personas.some((p) => p.path === sel) ? sel : "";
		// Hide the control entirely when no personas exist.
		this.personaSelect.toggle(personas.length > 0);
	}

	private async onPersonaChange(): Promise<void> {
		if (this.isBusy("changing persona")) {
			this.personaSelect.value = this.plugin.settings.selectedPersona;
			return;
		}
		this.plugin.settings.selectedPersona = this.personaSelect.value;
		await this.plugin.saveSettings();
		// A different system prompt means a new conversation.
		await this.startFreshSession();
		const name = this.personaSelect.selectedOptions[0]?.text ?? "Default";
		this.setStatus(`Persona: ${name}`);
	}

	// ----------------------------------------------------------- save chat

	/** Save the conversation (user + assistant text, no tool calls) as Markdown. */
	private async saveChat(): Promise<void> {
		if (this.session.transcript.length === 0) {
			new Notice("No conversation to save yet.");
			return;
		}

		const folder = (this.plugin.settings.chatSaveFolder || "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				/* may already exist due to a race; ignore */
			}
		}

		// Stamp once per conversation so re-saving keeps the original date/time and name.
		if (!this.savedChatStamp) {
			const now = new Date();
			const pad = (n: number) => String(n).padStart(2, "0");
			this.savedChatStamp = {
				date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
				time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
			};
		}
		const { date, time } = this.savedChatStamp;
		const model = this.modelSelect.selectedOptions[0]?.text || this.modelSelect.value || "(unknown)";
		const persona = (this.personaSelect.selectedOptions[0]?.text || "Default (AGENTS.md)").replace(/^🎭\s*/, "");

		const frontmatter = [
			"---",
			`date: ${date}`,
			`time: ${time}`,
			`engine: ${this.plugin.settings.engine}`,
			`model: ${JSON.stringify(model)}`,
			`persona: ${JSON.stringify(persona)}`,
			"---",
			"",
		].join("\n");

		const content = frontmatter + this.buildTranscriptMarkdown();

		// Re-saving the same conversation updates the file created the first time.
		if (this.savedChatPath) {
			const existing = this.app.vault.getAbstractFileByPath(this.savedChatPath);
			if (existing instanceof TFile) {
				try {
					await this.app.vault.modify(existing, content);
					new Notice(`Chat aktualisiert: ${existing.path}`);
				} catch (err) {
					new Notice(`Speichern fehlgeschlagen: ${errorMessage(err)}`);
				}
				return;
			}
			this.savedChatPath = null; // file was moved/deleted — make a fresh one
		}

		const firstUser = this.session.transcript.find((t) => t.role === "user")?.text ?? "Chat";
		const base = `${date} ${time.replace(":", "")} ${this.fileSlug(firstUser)}`.trim();
		const dir = folder ? folder + "/" : "";
		let name = `${base}.md`;
		for (let i = 1; this.app.vault.getAbstractFileByPath(normalizePath(dir + name)); i++) {
			name = `${base} (${i}).md`;
		}

		try {
			const file = await this.app.vault.create(normalizePath(dir + name), content);
			this.savedChatPath = file.path;
			new Notice(`Chat gespeichert: ${file.path}`);
		} catch (err) {
			new Notice(`Speichern fehlgeschlagen: ${errorMessage(err)}`);
		}
	}

	private buildTranscriptMarkdown(): string {
		const parts: string[] = [];
		let lastRole = "";
		for (const m of this.session.transcript) {
			const text = m.text.trim();
			if (!text) continue;
			if (m.role === lastRole) {
				parts.push("", text);
			} else {
				parts.push("", m.role === "user" ? "## You" : "## Assistant", "", text);
				lastRole = m.role;
			}
		}
		return parts.join("\n").trim() + "\n";
	}

	// --------------------------------------------------- debug log export

	/**
	 * Export the full debug log of the active session — metadata plus a faithful,
	 * chronological record of prompts, thinking, tool calls *with complete
	 * payloads*, and per-run token stats — so you can see exactly what the model
	 * did and where the tokens went. The log lives on the live runtime, so this
	 * works while the session is warm (not after a restart/eviction).
	 */
	private async exportDebugLog(): Promise<void> {
		const runtime = this.runtime;
		if (!runtime || runtime.debugLog.length === 0) {
			new Notice("No activity logged yet — send a prompt first.");
			return;
		}

		const folder = (this.plugin.settings.chatSaveFolder || "").trim().replace(/^[\\/]+|[\\/]+$/g, "");
		if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				/* may already exist due to a race; ignore */
			}
		}

		const content = this.buildDebugMarkdown(runtime.debugLog);

		const now = new Date();
		const pad = (n: number) => String(n).padStart(2, "0");
		const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
		const base = `${stamp} ${this.fileSlug(this.session.name || "Chat")} debug`;
		const dir = folder ? folder + "/" : "";
		let name = `${base}.md`;
		for (let i = 1; this.app.vault.getAbstractFileByPath(normalizePath(dir + name)); i++) {
			name = `${base} (${i}).md`;
		}

		try {
			const file = await this.app.vault.create(normalizePath(dir + name), content);
			new Notice(`Debug-Log exportiert: ${file.path}`);
			void this.app.workspace.getLeaf(true).openFile(file);
		} catch (err) {
			new Notice(`Export fehlgeschlagen: ${errorMessage(err)}`);
		}
	}

	/** Render the debug log as Markdown with a metadata + token-burn summary header. */
	private buildDebugMarkdown(log: DebugLogEntry[]): string {
		const fence = (content: string, lang = ""): string => {
			const runs: string[] = content.match(/`+/g) ?? [];
			const longest = runs.reduce((m, s) => Math.max(m, s.length), 0);
			const ticks = "`".repeat(Math.max(3, longest + 1));
			return `${ticks}${lang}\n${content}\n${ticks}`;
		};
		const time = (t: number) => {
			const d = new Date(t);
			const pad = (n: number) => String(n).padStart(2, "0");
			return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
		};

		const model = this.modelSelect.selectedOptions[0]?.text || this.modelSelect.value || "(unknown)";
		const persona = (this.personaSelect.selectedOptions[0]?.text || "Default (AGENTS.md)").replace(/^🎭\s*/, "");

		const toolCalls = log.filter((e): e is Extract<DebugLogEntry, { kind: "tool" }> => e.kind === "tool");
		const runs = log.filter((e) => e.kind === "run-start").length;
		const tokenStats = log.filter((e): e is Extract<DebugLogEntry, { kind: "stats" }> => e.kind === "stats");
		const tokenSum = tokenStats.reduce((s, e) => s + (e.tokensTotal ?? 0), 0);
		const peakTokens = tokenStats.reduce((m, e) => Math.max(m, e.tokensTotal ?? 0), 0);
		const resultChars = toolCalls.reduce((s, e) => s + (e.result?.length ?? 0), 0);
		const largest = toolCalls.reduce(
			(m, e) => ((e.result?.length ?? 0) > m.len ? { len: e.result?.length ?? 0, name: e.name } : m),
			{ len: 0, name: "" }
		);

		const head = [
			`# Debug export — ${this.session.name || "Chat"}`,
			"",
			"## Metadata",
			`- engine: \`${this.plugin.settings.engine}\``,
			`- model: \`${model}\``,
			`- persona: ${persona}`,
			`- session id: \`${this.session.id}\``,
			`- engine session id: \`${this.session.engineSessionId ?? "(none)"}\``,
			`- exported: ${new Date().toLocaleString()}`,
			"",
			"## Token / tool summary",
			`- runs (prompt round-trips): **${runs}**`,
			`- tool calls: **${toolCalls.length}**`,
			`- summed run tokens (Σ per-run totals — a proxy for total burn): **${tokenSum.toLocaleString()}**`,
			`- peak single-run tokens: **${peakTokens.toLocaleString()}**`,
			`- total tool-result chars fed back: **${resultChars.toLocaleString()}**`,
			largest.len ? `- largest tool result: **${largest.len.toLocaleString()} chars** (\`${largest.name}\`)` : "",
			"",
			"> In subscription mode the full item history (incl. every tool result) is re-sent each round-trip, so per-run tokens grow with every tool call — watch how `summed run tokens` climbs.",
			"",
			"---",
			"",
		]
			.filter((l) => l !== "")
			.join("\n");

		const parts: string[] = [head];
		let run = 0;
		for (const e of log) {
			switch (e.kind) {
				case "run-start":
					run++;
					parts.push(`\n## ▶ Run ${run}  ·  ${time(e.t)}`);
					break;
				case "run-end":
					parts.push(`\n_— end run ${run} —_`);
					break;
				case "user":
					parts.push(`\n### 🧑 You`, "", e.text.trim());
					break;
				case "assistant":
					parts.push(`\n### 🤖 Assistant`, "", e.text.trim());
					break;
				case "thinking":
					parts.push(`\n### 🤔 Thinking`, "", fence(e.text.trim()));
					break;
				case "tool": {
					const status = e.isError ? "❌ ERROR" : "✓";
					const args = (() => {
						try {
							return JSON.stringify(e.args ?? {}, null, 2);
						} catch {
							return String(e.args);
						}
					})();
					const chars = e.result?.length ?? 0;
					parts.push(
						`\n### 🔧 ${e.name}  ${status}  ·  ${time(e.t)}`,
						"",
						"**args:**",
						fence(args, "json"),
						`**result** (${chars.toLocaleString()} chars):`,
						fence(e.result ?? "(no result captured)")
					);
					break;
				}
				case "stats":
					parts.push(`\n_run tokens: ${(e.tokensTotal ?? 0).toLocaleString()}${e.cost != null ? ` · cost: ${e.cost}` : ""}_`);
					break;
			}
		}
		return parts.join("\n").trim() + "\n";
	}

	/** Short, filesystem-safe slug from the first line of a message. */
	private fileSlug(s: string): string {
		const firstLine = s.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "Chat";
		const cleaned = firstLine
			.replace(/[\\/:*?"<>|#^[\]]/g, "")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 50)
			.trim();
		return cleaned || "Chat";
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

		// Parse the porcelain status into a changed-file list for the dialog.
		const files = status.stdout
			.split("\n")
			.filter((l) => l.length > 3)
			.map((l) => ({ status: l.slice(0, 2).trim() || "?", path: l.slice(3) }));

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
			message: `${files.length} changed file${files.length === 1 ? "" : "s"}`,
			files,
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
		const wrap = this.mainEl.createDiv({ cls: "llm-input-row" });
		this.inputEl = wrap.createEl("textarea", {
			cls: "llm-input",
			attr: { placeholder: "Ask the agent about your wiki… (Enter to send, Shift+Enter for newline)", rows: "3" },
		});
		this.registerDomEvent(this.inputEl, "keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.onSend();
			}
		});
		this.sendBtn = wrap.createEl("button", { cls: "llm-send-btn", text: "Send" });
		this.registerDomEvent(this.sendBtn, "click", () => this.onSend());
	}

	/** Rebuild the persona dropdown and quick-prompt bar (personas changed on disk). */
	reloadPersonas(): void {
		this.renderPersonaSelect();
		this.renderQuickPrompts();
	}

	/**
	 * Quick-prompt buttons come from the active persona's frontmatter `prompts:`,
	 * or — in Default (AGENTS.md) mode — from the AGENTS.md frontmatter.
	 */
	private renderQuickPrompts(): void {
		if (!this.quickBarEl) return;
		this.quickBarEl.empty();
		const persona = this.plugin.getPersonaByPath(this.session.persona);
		const prompts = persona ? persona.prompts : this.plugin.getDefaultPrompts();
		if (prompts.length === 0) {
			this.quickBarEl.hide();
			return;
		}
		this.quickBarEl.show();
		for (const p of prompts) {
			const btn = this.quickBarEl.createEl("button", { cls: "llm-quick-btn", text: p.label });
			if (p.prompt) btn.setAttribute("aria-label", p.prompt);
			this.registerDomEvent(btn, "click", () => {
				if (!p.prompt.trim()) {
					new Notice(`Prompt "${p.label}" has no text.`);
					return;
				}
				void this.submitMessage(p.prompt);
			});
		}
	}

	// ------------------------------------------------------------- lifecycle

	private async connect(): Promise<void> {
		if (this.runtime?.running) return;
		const cwd = this.plugin.getWorkingDir();
		if (!cwd) {
			this.setStatus("Cannot resolve vault path — a local vault is required.", true);
			return;
		}

		// The view's chrome reflects the active session's config.
		this.engineSelect.value = this.session.engine;
		this.renderPersonaSelect();
		this.renderQuickPrompts();

		// Acquire the session's runtime (warm if it kept streaming in the background)
		// and start it if it's cold. The runtime owns the backend + transcript.
		const runtime = this.plugin.sessionManager.acquire(this.session);
		this.runtime = runtime;
		if (!runtime.backend) {
			const err = runtime.start();
			if (err) {
				this.setStatus(err, true);
				return;
			}
		}
		runtime.attach({
			onEvent: (ev) => this.handleBackendEvent(ev),
			onDialog: (req) => this.handleDialog(req),
			onPermission: (req) => this.handlePermission(req),
			onError: (name, e) => this.setStatus(`${name} error: ${e.message}`, true),
			onExit: (name, code, tail) => {
				this.streaming = false;
				this.hideWorking();
				this.refreshSendState();
				this.setStatus(
					`${name} process exited${code != null ? ` (code ${code})` : ""}.${tail ? " " + tail.split("\n").pop() : ""}`,
					true
				);
				this.addReconnectNotice();
			},
		});
		runtime.markSeen();
		this.adoptRuntimeState();
		this.plugin.sessionManager.enforceCap();

		const resumed = this.session.engineSessionId;
		this.setStatus(`Connected · ${resumed ? `resumed ${resumed.slice(0, 8)}` : "new session"} · cwd: ${cwd}`);
		await this.loadModels();
		await this.refreshStats();
	}

	/** Reflect the (possibly mid-stream, warm) runtime's state in the view. */
	private adoptRuntimeState(): void {
		const r = this.runtime;
		this.streaming = r?.streaming ?? false;
		if (r && this.streaming) {
			// Seed the in-progress assistant block with what streamed while detached.
			this.resetStreamState();
			this.runStartMs = Date.now();
			this.runTokens = 0;
			this.currentText = r.currentBuf;
			this.currentTextEl = this.newAssistantTextBlock();
			if (!this.structuredResponse && this.currentText) {
				this.renderMarkdownInto(this.currentTextEl, this.currentText);
			}
			this.showWorking();
			this.startWorkingTimer();
		}
		this.refreshSendState();
	}

	/**
	 * Stop rendering the current session's runtime. If it's still streaming it is
	 * kept **warm** (keeps running headlessly in the background); an idle runtime
	 * is disposed (it can be resumed on demand when revisited).
	 */
	private leaveCurrentRuntime(): void {
		const r = this.runtime;
		if (!r) return;
		this.runtime = null;
		this.stopWorkingTimer();
		if (r.streaming) r.detach();
		else this.plugin.sessionManager.release(r.session.id);
	}

	private addReconnectNotice(): void {
		const btn = this.statusMsgEl.createEl("button", { text: "Reconnect", cls: "llm-reconnect-btn" });
		this.registerDomEvent(btn, "click", async () => {
			if (this.runtime) {
				this.plugin.sessionManager.release(this.runtime.session.id);
				this.runtime = null;
			}
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

	/**
	 * Open a fresh session and attach a page (and optional selection) as immutable
	 * context shown above the input. The context is prepended to the user's next
	 * message. The agent still has full vault access (it runs in the vault root).
	 */
	async seedContext(pagePath: string, selection?: string, persona = ""): Promise<void> {
		// Apply the requested persona ("" = Default/AGENTS.md) before the engine
		// launches, so the new chat starts with the right system prompt.
		const personaChanged = this.plugin.settings.selectedPersona !== persona;
		this.plugin.settings.selectedPersona = persona;
		if (personaChanged) {
			await this.plugin.saveSettings();
			this.renderPersonaSelect();
		}

		// Relaunch on a fresh session whenever a backend is already running (it may
		// have started with a different persona) or a conversation exists. A truly
		// just-opened panel connects for the first time with the persona set above.
		if (this.backend != null || this.transcriptEl.childElementCount > 0) {
			await this.startFreshSession();
		} else {
			await this.ensureRunning();
		}

		const sel = selection ? selection.replace(/\r\n/g, "\n").trim() : undefined;
		this.pendingContext = { pagePath, selection: sel || undefined };
		this.pendingContextAuto = false; // explicit attach — don't auto-remove
		this.renderPendingContext();
		this.inputEl.value = "";
		this.inputEl.focus();
		this.setStatus(
			sel
				? `Context from ${pagePath} attached — type your question.`
				: `Page ${pagePath} attached — type your question.`
		);
	}

	/**
	 * Attach an editor selection as the pending context chip without touching the
	 * session (used by the auto-attach-on-selection setting). No-op if it already
	 * matches the current chip.
	 */
	setSelectionContext(pagePath: string, selection: string): void {
		const sel = selection.replace(/\r\n/g, "\n").trim();
		if (!sel) return;
		if (this.pendingContext?.pagePath === pagePath && this.pendingContext.selection === sel) return;
		this.pendingContext = { pagePath, selection: sel };
		this.pendingContextAuto = true;
		this.renderPendingContext();
	}

	/** Remove the chip if it was auto-attached (the selection was cleared in-note). */
	clearSelectionContext(): void {
		if (!this.pendingContextAuto || !this.pendingContext) return;
		this.pendingContext = null;
		this.pendingContextAuto = false;
		this.renderPendingContext();
	}

	private renderPendingContext(): void {
		this.contextEl.empty();
		const ctx = this.pendingContext;
		if (!ctx) {
			this.contextEl.hide();
			return;
		}
		this.contextEl.show();

		const head = this.contextEl.createDiv({ cls: "llm-context-head" });
		const icon = head.createSpan({ cls: "llm-context-icon" });
		setIcon(icon, ctx.selection ? "text-quote" : "file-text");
		const pathEl = head.createSpan({ cls: "llm-context-path", text: ctx.pagePath });
		pathEl.setAttribute("aria-label", `Open ${ctx.pagePath}`);
		this.registerDomEvent(pathEl, "click", () => {
			void this.app.workspace.openLinkText(ctx.pagePath, "", false);
		});
		const clear = head.createEl("button", { cls: "llm-context-clear", attr: { "aria-label": "Remove context" } });
		setIcon(clear, "x");
		this.registerDomEvent(clear, "click", () => {
			this.pendingContext = null;
			this.pendingContextAuto = false;
			this.renderPendingContext();
		});

		if (ctx.selection) {
			this.contextEl.createDiv({ cls: "llm-context-body", text: ctx.selection });
		}
	}

	private async startNewSession(): Promise<void> {
		// Safe during streaming now: the current session keeps running in the
		// background (kept warm) while a fresh one opens.
		await this.startFreshSession();
	}

	// --------------------------------------------------------------- sessions

	private makeSession(): SavedSession {
		const now = Date.now();
		return {
			id: newSessionId(),
			name: "",
			engine: this.plugin.settings.engine,
			engineSessionId: undefined,
			model: "",
			persona: this.plugin.settings.selectedPersona,
			transcript: [],
			createdAt: now,
			updatedAt: now,
		};
	}

	/** Start a brand-new session. The previous one is already persisted (if it had
	 * messages), so nothing is lost. */
	private async startFreshSession(): Promise<void> {
		this.leaveCurrentRuntime();
		this.session = this.makeSession();
		this.clearConversationDom();
		await this.connect();
		this.renderSessionList();
		this.setStatus("New session.");
	}

	private async switchSession(id: string): Promise<void> {
		const target = this.plugin.sessionStore.get(id);
		if (!target || target.id === this.session.id) return;

		// Leaving keeps a still-streaming session warm in the background.
		this.leaveCurrentRuntime();
		this.session = target;
		// Align engine + persona so the engine can resume the right conversation.
		this.plugin.settings.engine = target.engine;
		this.plugin.settings.selectedPersona = target.persona;
		await this.plugin.saveSettings();
		this.engineSelect.value = target.engine;

		this.plugin.sessionStore.setActive(target.id);
		this.clearConversationDom();
		this.renderTranscriptFromSession();
		await this.connect();
		this.renderSessionList();
		this.setStatus(`Session: ${target.name || "Untitled"}`);
	}

	// ----------------------------------------------------------- session sidebar

	private buildSidebar(): void {
		const head = this.sidebarEl.createDiv({ cls: "llm-sidebar-head" });
		head.createSpan({ cls: "llm-sidebar-title", text: "Sessions" });
		const newBtn = head.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "New session" } });
		setIcon(newBtn, "plus");
		this.registerDomEvent(newBtn, "click", () => void this.startNewSession());

		this.sessionListEl = this.sidebarEl.createDiv({ cls: "llm-sidebar-list" });
	}

	private toggleSidebar(): void {
		this.plugin.settings.sidebarCollapsed = !this.plugin.settings.sidebarCollapsed;
		void this.plugin.saveSettings();
		this.applySidebarState();
	}

	private applySidebarState(): void {
		this.sidebarEl.toggleClass("is-collapsed", this.plugin.settings.sidebarCollapsed);
	}

	/** Public hook for the plugin to refresh sidebars when any runtime changes. */
	reloadSessionList(): void {
		this.renderSessionList();
	}

	/** Rebuild the session list. The active session is always shown (even before
	 *  it is persisted), highlighted, newest first. Background runtimes get a
	 *  status dot (streaming / unseen reply). */
	private renderSessionList(): void {
		if (!this.sessionListEl) return;
		this.sessionListEl.empty();

		const saved = this.plugin.sessionStore.getAll();
		const list = saved.some((s) => s.id === this.session.id) ? saved.slice() : [this.session, ...saved];
		// Stable order by creation time (newest first) so a new reply — which bumps
		// updatedAt — doesn't reshuffle the list while you work.
		list.sort((a, b) => b.createdAt - a.createdAt);

		if (list.length === 0) {
			this.sessionListEl.createDiv({ cls: "llm-session-empty", text: "No sessions yet." });
			return;
		}

		for (const s of list) {
			const active = s.id === this.session.id;
			const item = this.sessionListEl.createDiv({ cls: "llm-session-item" + (active ? " is-active" : "") });
			this.registerDomEvent(item, "click", () => void this.switchSession(s.id));
			this.registerDomEvent(item, "contextmenu", (e) => this.openSessionItemMenu(e, s.id));

			// Status dot for background sessions: streaming (live) or unseen reply
			// (persisted, so it survives an LRU eviction / restart).
			const rt = this.plugin.sessionManager.get(s.id);
			const dot = item.createSpan({ cls: "llm-session-dot" });
			if (!active && rt?.streaming) dot.addClass("is-streaming");
			else if (!active && s.unseen) dot.addClass("is-unseen");

			const body = item.createDiv({ cls: "llm-session-body" });
			body.createDiv({ cls: "llm-session-name", text: s.name || "New chat" });
			const meta = [this.plugin.engineLabel(), s.model].filter(Boolean).join(" · ");
			if (meta) body.createDiv({ cls: "llm-session-meta", text: meta });

			const actions = item.createDiv({ cls: "llm-session-actions" });
			const rename = actions.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Rename" } });
			setIcon(rename, "pencil");
			this.registerDomEvent(rename, "click", (e) => {
				e.stopPropagation();
				void this.renameSession(s.id);
			});
			const del = actions.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Delete" } });
			setIcon(del, "trash");
			this.registerDomEvent(del, "click", (e) => {
				e.stopPropagation();
				void this.deleteSession(s.id);
			});
		}
	}

	private openSessionItemMenu(evt: MouseEvent, id: string): void {
		evt.preventDefault();
		const menu = new Menu();
		menu.addItem((i) => i.setTitle("Rename…").setIcon("pencil").onClick(() => void this.renameSession(id)));
		menu.addItem((i) => i.setTitle("Delete").setIcon("trash").onClick(() => void this.deleteSession(id)));
		const others = this.plugin.sessionStore.getAll().filter((s) => s.id !== id).length;
		if (others > 0) {
			menu.addSeparator();
			menu.addItem((i) =>
				i
					.setTitle("Delete all other sessions")
					.setIcon("trash-2")
					.onClick(() => void this.deleteOtherSessions(id))
			);
		}
		menu.showAtMouseEvent(evt);
	}

	/** The live session object for an id (the active one may not be persisted yet). */
	private sessionById(id: string): SavedSession | undefined {
		return id === this.session.id ? this.session : this.plugin.sessionStore.get(id);
	}

	private async renameSession(id: string): Promise<void> {
		const target = this.sessionById(id);
		if (!target) return;
		const answer = await showUIDialog(this.app, {
			type: "extension_ui_request",
			id: "rename-session",
			method: "input",
			title: "Rename session",
			prefill: target.name,
		});
		if (answer.cancelled) return;
		target.name = (typeof answer.value === "string" && answer.value.trim()) || target.name;
		target.updatedAt = Date.now();
		if (target.transcript.length) this.plugin.sessionStore.upsert(target);
		this.renderSessionList();
	}

	private async deleteSession(id: string): Promise<void> {
		const isActive = id === this.session.id;
		if (isActive && this.isBusy("deleting the session")) return;
		this.plugin.sessionManager.release(id); // dispose its backend if running
		this.plugin.sessionStore.remove(id);
		if (isActive) {
			this.runtime = null; // just released
			await this.startFreshSession();
		} else {
			this.renderSessionList();
			this.setStatus("Session deleted.");
		}
	}

	/** Delete every saved session except the given one (with confirmation). */
	private async deleteOtherSessions(keepId: string): Promise<void> {
		if (this.isBusy("deleting sessions")) return;
		const others = this.plugin.sessionStore.getAll().filter((s) => s.id !== keepId).length;
		if (others === 0) {
			new Notice("No other sessions to delete.");
			return;
		}
		const answer = await showUIDialog(this.app, {
			type: "extension_ui_request",
			id: "delete-other-sessions",
			method: "confirm",
			title: "Delete all other sessions?",
			message: `This permanently removes ${others} other session${others === 1 ? "" : "s"}, keeping only the current one. This cannot be undone.`,
		});
		if (answer.confirmed !== true) return;
		// Dispose the runtimes of the sessions about to be removed.
		for (const s of this.plugin.sessionStore.getAll()) {
			if (s.id !== keepId) this.plugin.sessionManager.release(s.id);
		}
		const removed = this.plugin.sessionStore.keepOnly(keepId);
		// Keeping a non-active session deletes the active one — switch to the kept one.
		if (keepId !== this.session.id) {
			this.runtime = null; // the active runtime was just released
			await this.switchSession(keepId);
		}
		this.renderSessionList();
		this.setStatus(`Deleted ${removed} other session${removed === 1 ? "" : "s"}.`);
	}

	private clearConversationDom(): void {
		this.transcriptEl.empty();
		this.workingEl = null;
		this.savedChatPath = null;
		this.savedChatStamp = null;
		this.resetStreamState();
	}

	private renderTranscriptFromSession(): void {
		for (const m of this.session.transcript) {
			if (m.role === "user") this.renderUserBlock(m.text);
			else this.renderAssistantBlock(m);
		}
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
			this.updateStatusModel();
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
		this.session.model = this.modelSelect.selectedOptions[0]?.text || this.session.model;
		this.updateStatusModel();
		this.updateConfigVisibility();
	}

	private async onModelChange(): Promise<void> {
		if (!this.backend?.running) return;
		const key = this.modelSelect.value;
		if (!key) return;
		const res = await this.backend.setModel(key);
		if (!res.ok) {
			new Notice(`Could not switch model: ${res.error ?? "unknown error"}`);
		} else {
			this.session.model = this.modelSelect.selectedOptions[0]?.text || this.session.model;
			this.setStatus(`Model: ${this.modelSelect.selectedOptions[0]?.text ?? key}`);
			this.updateStatusModel();
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
		const runtime = this.runtime;
		if (!runtime?.running) {
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
			this.pendingContextAuto = false;
			this.renderPendingContext();
		}

		// The runtime records the user turn in the transcript; the view renders it.
		this.renderUserBlock(message);
		this.showWorking();

		try {
			const res = await runtime.prompt(message, this.streaming);
			if (!res.ok) {
				this.hideWorking();
				if (this.streaming) new Notice(res.error ?? "Message rejected.");
				else this.setStatus(res.error ?? "Prompt rejected.", true);
			}
		} catch (err) {
			this.hideWorking();
			this.setStatus(`Send failed: ${errorMessage(err)}`, true);
		}
	}

	// ----------------------------------------------------------- event stream

	private handleBackendEvent(ev: BackendEvent): void {
		switch (ev.type) {
			case "run-start":
				this.streaming = true;
				this.resetStreamState();
				this.runStartMs = Date.now();
				this.runTokens = 0;
				this.showWorking();
				this.startWorkingTimer();
				this.refreshSendState();
				break;

			case "text-start":
				this.finalizeThinking();
				// The model is producing its answer now — drop any "calling …" label.
				if (this.currentToolLabel) {
					this.currentToolLabel = "";
					this.updateWorkingMeta();
				}
				this.currentText = "";
				this.currentTextEl = this.newAssistantTextBlock();
				break;
			case "text-delta":
				if (!this.currentTextEl) this.currentTextEl = this.newAssistantTextBlock();
				this.currentText += ev.delta;
				// For structured personas the deltas are raw JSON; don't render them
				// live — buffer and parse on completion (working indicator stays up).
				if (!this.structuredResponse) this.scheduleRender();
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
				if (ev.stats.tokensTotal) {
					this.runTokens = ev.stats.tokensTotal;
					this.updateWorkingMeta();
				}
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
		const block = this.appendBlock("llm-msg llm-msg-error");
		block.createDiv({ cls: "llm-error-label", text: "error" });
		block.createDiv({ cls: "llm-error-body", text });
		this.scrollToBottom(true);
	}

	// ---------------------------------------------------------- tool rendering

	private onToolStart(ev: Extract<BackendEvent, { type: "tool-start" }>): void {
		if (!this.plugin.settings.showToolCalls) {
			// Hidden mode: surface the active tool in the busy indicator instead. It
			// stays until the next tool starts or the model emits text (see text-start).
			this.currentToolLabel = this.toolActionLabel(ev.name, ev.args);
			this.updateWorkingMeta();
			return;
		}
		const block = this.newToolBlock(ev.name, ev.args);
		this.toolBlocks.set(ev.id, block);
	}

	private onToolUpdate(ev: Extract<BackendEvent, { type: "tool-update" }>): void {
		const block = this.toolBlocks.get(ev.id);
		if (!block) return;
		if (ev.text) this.setToolBody(block, ev.text, false);
	}

	private onToolEnd(ev: Extract<BackendEvent, { type: "tool-end" }>): void {
		// In hidden mode there is no block; the label is left in place until the next
		// tool or text replaces it, so don't clear it here.
		const block = this.toolBlocks.get(ev.id);
		if (!block) return;
		this.setToolBody(block, ev.text || (ev.isError ? "(error)" : "(done)"), ev.isError);
		block.root.toggleClass("llm-tool-error", ev.isError);
		const badge = block.titleEl.querySelector(".llm-tool-status");
		if (badge) badge.setText(ev.isError ? "error" : "done");
	}

	/** Short phrase for the busy indicator, e.g. "calling git" / "calling read". */
	private toolActionLabel(name: string, args: unknown): string {
		const n = (name || "").toLowerCase();
		if (n === "bash") {
			const a = args && typeof args === "object" ? (args as Record<string, unknown>) : null;
			const cmd = a && typeof a.command === "string" ? a.command.trim() : "";
			const first = cmd.split(/\s+/)[0]?.replace(/[^a-zA-Z0-9_.\-]/g, "");
			return first ? `calling ${first}` : "calling bash";
		}
		return n ? `calling ${n}` : "working";
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
			this.workingEl = this.transcriptEl.createDiv({ cls: "llm-working", attr: { "aria-label": "Working" } });
			const dots = this.workingEl.createDiv({ cls: "llm-working-dots" });
			for (let i = 0; i < 3; i++) dots.createSpan({ cls: "llm-working-dot" });
			this.workingEl.createSpan({ cls: "llm-working-meta" });
		}
		this.updateWorkingMeta();
		this.transcriptEl.appendChild(this.workingEl); // keep it last
		this.scrollToBottom();
	}

	private hideWorking(): void {
		this.stopWorkingTimer();
		this.runStartMs = 0;
		this.workingEl?.remove();
		this.workingEl = null;
	}

	/** Tick the working indicator's elapsed time every second and poll token usage. */
	private startWorkingTimer(): void {
		this.stopWorkingTimer();
		this.workingTimer = window.setInterval(() => {
			this.updateWorkingMeta();
			// Poll usage every other tick (pi answers via RPC; Claude reads a cache).
			if (this.runStartMs && Math.floor((Date.now() - this.runStartMs) / 1000) % 2 === 0) {
				void this.pollRunTokens();
			}
		}, 1000);
	}

	private stopWorkingTimer(): void {
		if (this.workingTimer != null) {
			window.clearInterval(this.workingTimer);
			this.workingTimer = null;
		}
	}

	/** Repaint the elapsed-time · token-count line on the working indicator. */
	private updateWorkingMeta(): void {
		const meta = this.workingEl?.querySelector(".llm-working-meta") as HTMLElement | null;
		if (!meta) return;
		if (!this.runStartMs) {
			meta.textContent = "";
			return;
		}
		const parts: string[] = [formatDuration(Math.floor((Date.now() - this.runStartMs) / 1000))];
		if (this.runTokens > 0) parts.push(`${formatTokens(this.runTokens)} tokens`);
		if (this.currentToolLabel) parts.push(this.currentToolLabel);
		meta.textContent = parts.join(" · ");
	}

	private async pollRunTokens(): Promise<void> {
		if (this.statsPolling || !this.backend) return;
		this.statsPolling = true;
		try {
			const stats = await this.backend.getStats();
			if (stats?.tokensTotal && stats.tokensTotal !== this.runTokens) {
				this.runTokens = stats.tokensTotal;
				this.updateWorkingMeta();
			}
		} catch {
			/* transient; ignore */
		} finally {
			this.statsPolling = false;
		}
	}

	private renderUserBlock(text: string): void {
		const block = this.appendBlock("llm-msg llm-msg-user");
		const body = block.createDiv({ cls: "llm-msg-body" });
		void this.renderMarkdownInto(body, text).then(() => this.pinBottom());
		this.pinBottom();
	}

	private renderAssistantBlock(m: SessionMessage): void {
		const block = this.appendBlock("llm-msg llm-msg-assistant");
		const body = block.createDiv({ cls: "llm-msg-body" });
		// Restore structured chips/checkboxes when the message carries envelopes.
		if (m.envelopes && m.envelopes.length) {
			this.renderStructuredInto(body, m.envelopes); // pins after its async render
		} else {
			const stick = this.nearBottom();
			void this.renderMarkdownInto(body, m.text).then(() => {
				if (stick) this.pinBottom();
			});
			if (stick) this.pinBottom();
		}
	}

	private newAssistantTextBlock(): HTMLElement {
		const block = this.appendBlock("llm-msg llm-msg-assistant");
		const body = block.createDiv({ cls: "llm-msg-body" });
		this.scrollToBottom();
		return body;
	}

	private newThinkingBlock(): HTMLElement {
		const block = this.appendBlock("llm-msg llm-msg-thinking");
		block.createDiv({ cls: "llm-thinking-label", text: "thinking" });
		const body = block.createEl("pre", { cls: "llm-thinking-body" });
		this.scrollToBottom();
		return body;
	}

	private newToolBlock(toolName: string, args: unknown): ToolBlock {
		const root = this.appendBlock("llm-tool");
		const header = root.createDiv({ cls: "llm-tool-header" });
		const titleEl = header.createDiv({ cls: "llm-tool-title" });
		const icon = titleEl.createSpan({ cls: "llm-tool-icon" });
		setIcon(icon, this.toolIcon(toolName));
		titleEl.createSpan({ cls: "llm-tool-name", text: toolName });
		const argEl = titleEl.createSpan({ cls: "llm-tool-arg", text: this.summarizeArgs(toolName, args) });
		const full = this.fullArgs(args);
		if (full) argEl.setAttribute("title", full);
		titleEl.createSpan({ cls: "llm-tool-status", text: "running" });

		const body = root.createEl("pre", { cls: "llm-tool-body" });
		body.hide();

		this.registerDomEvent(header, "click", () => {
			if (body.isShown()) body.hide();
			else body.show();
		});
		this.scrollToBottom();
		return { root, header, body, titleEl };
	}

	private setToolBody(block: ToolBlock, text: string, isError: boolean): void {
		const trimmed = text.length > 20000 ? text.slice(0, 20000) + "\n… (truncated)" : text;
		block.body.setText(trimmed);
		block.body.toggleClass("llm-tool-body-error", isError);
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

	private summarizeArgs(toolName: string, args: unknown): string {
		if (!args || typeof args !== "object") return "";
		const a = args as Record<string, unknown>;
		if (typeof a.path === "string") return a.path;
		if (typeof a.file === "string") return a.file;
		if (typeof a.file_path === "string") return a.file_path;
		if (typeof a.command === "string") return this.firstLine(a.command);
		if (typeof a.pattern === "string") return this.firstLine(a.pattern);
		const keys = Object.keys(a);
		return keys.length ? `${keys[0]}=…` : "";
	}

	/** Collapse a multi-line value to its first non-empty line, marking the rest. */
	private firstLine(value: string): string {
		const lines = value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		if (lines.length === 0) return "";
		return lines.length > 1 ? `${lines[0]} …` : lines[0];
	}

	/** Full argument text for the hover tooltip. */
	private fullArgs(args: unknown): string {
		if (!args || typeof args !== "object") return "";
		const a = args as Record<string, unknown>;
		if (typeof a.command === "string") return a.command;
		if (typeof a.path === "string") return a.path;
		if (typeof a.file_path === "string") return a.file_path;
		if (typeof a.pattern === "string") return a.pattern;
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

	/** Renders markdown into `el`. The returned promise resolves once it's in the
	 *  DOM (callers re-pin the scroll then, since the height grows asynchronously). */
	private renderMarkdownInto(el: HTMLElement, markdown: string): Promise<void> {
		el.empty();
		return MarkdownRenderer.render(this.app, markdown, el, "", this).then(() => {
			this.linkifyPaths(el);
		});
	}

	private chooseOption(ol: HTMLElement, li: HTMLElement, reply: string): void {
		if (ol.classList.contains("llm-options-answered")) return;
		ol.classList.add("llm-options-answered");
		li.classList.add("llm-option-selected");
		void this.submitMessage(reply);
	}

	// --------------------------------------------- structured (schema) responses

	/** Render a sequence of response envelopes: text, single-choice, multi-choice. */
	private renderStructuredInto(body: HTMLElement, envs: ResponseEnvelope[]): void {
		const stick = this.nearBottom();
		body.empty();
		const renders: Promise<void>[] = [];
		for (const env of envs) {
			if (env.text) {
				const textEl = body.createDiv({ cls: "llm-structured-text" });
				renders.push(this.renderMarkdownInto(textEl, env.text));
			}
			if (env.type === "single_choice") {
				const ol = body.createEl("ol", { cls: "llm-options" });
				for (const opt of env.options) {
					const li = ol.createEl("li", { cls: "llm-option", text: opt });
					li.setAttribute("role", "button");
					li.setAttribute("tabindex", "0");
					const choose = () => this.chooseOption(ol, li, opt);
					this.registerDomEvent(li, "click", choose);
					this.registerDomEvent(li, "keydown", (e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							choose();
						}
					});
				}
			} else if (env.type === "multi_choice") {
				this.renderMultiChoice(body, env.options);
			}
		}
		// Chips are in the DOM now, but the question text renders asynchronously and
		// grows the height — re-pin to the bottom once that settles so nothing (the
		// chips/checkboxes especially) stays hidden below the fold.
		if (stick) {
			this.pinBottom();
			void Promise.all(renders).then(() => this.pinBottom());
		}
	}

	/** Checkbox list plus a Send button; submits the chosen option texts together. */
	private renderMultiChoice(body: HTMLElement, options: string[]): void {
		const wrap = body.createDiv({ cls: "llm-multi" });
		const boxes: HTMLInputElement[] = [];
		for (const opt of options) {
			const label = wrap.createEl("label", { cls: "llm-multi-option" });
			boxes.push(label.createEl("input", { type: "checkbox" }));
			label.createSpan({ text: opt });
		}
		const send = wrap.createEl("button", { cls: "llm-multi-send", text: "Send" });
		this.registerDomEvent(send, "click", () => {
			if (wrap.classList.contains("llm-options-answered")) return;
			const chosen = options.filter((_, i) => boxes[i].checked);
			if (chosen.length === 0) {
				new Notice("Select at least one option (or type your own reply).");
				return;
			}
			wrap.classList.add("llm-options-answered");
			boxes.forEach((b) => (b.disabled = true));
			send.disabled = true;
			void this.submitMessage(chosen.join("\n"));
		});
	}

	// ------------------------------------------------- vault page path linking

	/**
	 * Walk the rendered markdown and turn references to existing vault pages
	 * (e.g. `wiki/agentic-development/index.md`) into clickable links that open
	 * the page in the main document area. An optional `:line` (or `:line-range`)
	 * suffix — e.g. `notes/long.md:128` — opens the file scrolled to that line, so
	 * the agent can point at where it made a change. Paths that don't resolve to a
	 * real file are left as plain text.
	 */
	private linkifyPaths(root: HTMLElement): void {
		const pathRe = /([A-Za-z0-9_.\-/\\]+\.(?:md|markdown)\b)(?::(\d+)(?:-\d+)?)?/g;

		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (node: Node) => {
				const parent = (node as Text).parentElement;
				if (!parent) return NodeFilter.FILTER_REJECT;
				if (parent.closest("pre, a, .llm-page-link, .llm-option")) return NodeFilter.FILTER_REJECT;
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
				const dest = this.resolvePagePath(match[1]);
				if (!dest) continue;
				found = true;
				const line = match[2] ? parseInt(match[2], 10) : undefined;
				if (match.index > lastIndex) {
					frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
				}
				frag.appendChild(this.createPageLink(raw, dest, line));
				lastIndex = match.index + raw.length;
			}

			if (!found) continue;
			if (lastIndex < text.length) {
				frag.appendChild(document.createTextNode(text.slice(lastIndex)));
			}
			textNode.parentNode?.replaceChild(frag, textNode);
		}
	}

	private createPageLink(label: string, dest: TFile, line?: number): HTMLAnchorElement {
		const a = document.createElement("a");
		a.className = "llm-page-link";
		a.textContent = label;
		a.setAttribute("href", dest.path);
		a.setAttribute("aria-label", line != null ? `${dest.path}:${line}` : dest.path);
		this.registerDomEvent(a, "click", (e) => {
			e.preventDefault();
			const newLeaf: PaneType | boolean = e.ctrlKey || e.metaKey ? "tab" : false;
			void this.openPage(dest, line, newLeaf);
		});
		this.registerDomEvent(a, "auxclick", (e) => {
			if (e.button === 1) {
				e.preventDefault();
				void this.openPage(dest, line, "tab");
			}
		});
		return a;
	}

	/**
	 * Open a vault page, optionally scrolled to a 1-based line. Obsidian's
	 * ephemeral `{ line }` state (0-based) drives the scroll in both reading and
	 * editing mode — the same mechanism its search uses to jump to a result.
	 */
	private async openPage(dest: TFile, line: number | undefined, newLeaf: PaneType | boolean): Promise<void> {
		if (line == null) {
			await this.app.workspace.openLinkText(dest.path, "", newLeaf);
			return;
		}
		const leaf = this.app.workspace.getLeaf(newLeaf);
		await leaf.openFile(dest, { eState: { line: Math.max(0, line - 1) } });
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

	/** Render-only: the runtime owns pushing the finished message into the transcript. */
	private finalizeText(): void {
		if (this.currentTextEl) {
			const envs = this.structuredResponse ? parseResponseEnvelopes(this.currentText) : [];
			if (envs.length) {
				this.renderStructuredInto(this.currentTextEl, envs); // pins after its async render
			} else {
				const stick = this.nearBottom();
				void this.renderMarkdownInto(this.currentTextEl, this.currentText).then(() => {
					if (stick) this.pinBottom();
				});
				if (stick) this.pinBottom();
			}
		}
		this.currentTextEl = null;
		this.currentText = "";
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
		this.currentToolLabel = "";
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
				this.inputEl.value = String((req as { text?: unknown }).text ?? "");
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
		this.statusMsgEl.empty();
		this.statusMsgEl.setText(text);
		this.statusMsgEl.toggleClass("llm-status-error", isError);
	}

	/** Show the active engine · model on the right of the status line. */
	private updateStatusModel(): void {
		if (!this.statusModelEl) return;
		const model = this.modelSelect?.selectedOptions[0]?.text || this.modelSelect?.value || "";
		this.statusModelEl.setText(model ? `${this.plugin.engineLabel()} · ${model}` : this.plugin.engineLabel());
	}

	private refreshSendState(): void {
		if (this.streaming) {
			this.stopBtn.show();
			this.sendBtn.setText("Steer");
		} else {
			this.stopBtn.hide();
			this.sendBtn.setText("Send");
		}
		// A new session no longer aborts the running one (it stays warm in the
		// background), so the + button stays enabled while streaming.
		this.newBtn.disabled = false;
	}

	/** True (with a notice) if a run is in flight, used to block session changes. */
	private isBusy(action: string): boolean {
		if (this.streaming) {
			new Notice(`Finish or stop the current response before ${action}.`);
			return true;
		}
		return false;
	}

	private scrollToBottom(force = false): void {
		if (force || this.nearBottom()) this.pinBottom();
	}

	/** Whether the transcript is scrolled close to the bottom (user is "following"). */
	private nearBottom(): boolean {
		const el = this.transcriptEl;
		return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
	}

	private pinBottom(): void {
		this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
	}
}
