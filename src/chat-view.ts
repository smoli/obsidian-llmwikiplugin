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
import { PiBackend } from "./pi-backend";
import { ClaudeBackend } from "./claude-backend";
import { ExtensionUIRequest, ThinkingLevel } from "./rpc-types";
import { SavedSession, newSessionId } from "./sessions";
import { showUIDialog } from "./ui-dialog";

export const VIEW_TYPE = "llm-agent-chat";

/** Structured response shapes a schema persona may emit (see RESPONSE_SCHEMA_INSTRUCTION). */
type ResponseEnvelope =
	| { type: "message"; text: string }
	| { type: "single_choice"; text: string; options: string[] }
	| { type: "multi_choice"; text: string; options: string[] };

const MARKER_RE = /^>{2,3}\s*(message|single[_-]?choice|multi[_-]?choice|single|multi)\s*:?\s*$/i;
const OPTION_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/;

function normalizeMarker(raw: string): ResponseEnvelope["type"] {
	const m = raw.toLowerCase();
	if (m.includes("multi")) return "multi_choice";
	if (m.includes("single")) return "single_choice";
	return "message";
}

/**
 * Parse a structured response into a sequence of envelopes using the marker
 * protocol (a `>>> <type>` line per block; `- option` lines for choices). This
 * is deliberately tolerant: text is taken verbatim (no JSON escaping, so rich
 * prose with quotes never breaks it), and a reply with no markers degrades to a
 * single plain message. Returns an empty array only for empty input.
 */
function parseResponseEnvelopes(raw: string): ResponseEnvelope[] {
	let s = raw.trim();
	if (!s) return [];
	// Unwrap a single code fence wrapping the whole reply, if present.
	const fence = s.match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i);
	if (fence) s = fence[1].trim();

	const envs: ResponseEnvelope[] = [];
	let type: ResponseEnvelope["type"] = "message";
	let textLines: string[] = [];
	let options: string[] = [];
	let sawMarker = false;

	const flush = () => {
		const text = textLines.join("\n").trim();
		if (type === "message") {
			if (text) envs.push({ type: "message", text });
		} else if (options.length) {
			envs.push({ type, text, options });
		} else if (text) {
			envs.push({ type: "message", text });
		}
		textLines = [];
		options = [];
	};

	for (const line of s.split(/\r?\n/)) {
		const m = line.match(MARKER_RE);
		if (m) {
			flush();
			type = normalizeMarker(m[1]);
			sawMarker = true;
			continue;
		}
		if (type !== "message") {
			const opt = line.match(OPTION_RE);
			if (opt) {
				options.push(opt[1].trim());
				continue;
			}
		}
		textLines.push(line);
	}
	flush();

	// No markers at all → render the whole reply as one markdown message.
	if (!sawMarker) return s ? [{ type: "message", text: s }] : [];
	return envs;
}

/**
 * Markdown rendering of envelopes for the transcript (saved chats + session
 * restore). Choices become a numbered list — readable in saved chats; on restore
 * they render as a static list (the live chips come from renderStructuredInto).
 */
function envelopesToTranscript(envs: ResponseEnvelope[]): string {
	return envs
		.map((env) => {
			if (env.type === "message") return env.text.trim();
			const list = env.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
			return `${env.text.trim()}\n\n${list}`;
		})
		.filter(Boolean)
		.join("\n\n");
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
	private backend: AgentBackend | null = null;
	private models: BackendModel[] = [];

	// DOM
	private mainEl!: HTMLElement;
	private sidebarEl!: HTMLElement;
	private sessionListEl!: HTMLElement;
	private transcriptEl!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private quickBarEl!: HTMLElement;
	private contextEl!: HTMLElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private newBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
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
	// True when the active persona requests a structured response envelope; the
	// assistant message is then buffered and parsed instead of streamed as text.
	private structuredResponse = false;

	// Page (and optional selection) attached via the "ask about" context menu,
	// prepended to the next message.
	private pendingContext: { pagePath: string; selection?: string } | null = null;

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
		return "LLM Agent";
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("llm-agent-view");
		this.session = this.makeSession();

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
		this.renderSessionList();
		await this.connect();
	}

	async onClose(): Promise<void> {
		void this.plugin.sessionStore.flush();
		this.stopWorkingTimer();
		this.teardownBackend();
	}

	// ---------------------------------------------------------------- layout

	private buildHeader(): void {
		const header = this.mainEl.createDiv({ cls: "llm-header" });

		this.engineSelect = header.createEl("select", { cls: "llm-select llm-engine-select" });
		this.engineSelect.createEl("option", { text: "pi", value: "pi" });
		this.engineSelect.createEl("option", { text: "Claude Code", value: "claude" });
		this.engineSelect.value = this.plugin.settings.engine;
		this.engineSelect.addEventListener("change", () => this.onEngineChange());

		this.modelSelect = header.createEl("select", { cls: "llm-select llm-model-select" });
		this.modelSelect.createEl("option", { text: "Loading models…", value: "" });
		this.modelSelect.addEventListener("change", () => this.onModelChange());

		this.thinkingSelect = header.createEl("select", { cls: "llm-select llm-thinking-select" });
		for (const lvl of ["off", "minimal", "low", "medium", "high", "xhigh"]) {
			this.thinkingSelect.createEl("option", { text: `🧠 ${lvl}`, value: lvl });
		}
		this.thinkingSelect.value = this.plugin.settings.thinking;
		this.thinkingSelect.addEventListener("change", async () => {
			if (this.backend?.running) await this.backend.setThinking(this.thinkingSelect.value as ThinkingLevel);
		});

		this.personaSelect = header.createEl("select", { cls: "llm-select llm-persona-select" });
		this.personaSelect.addEventListener("change", () => this.onPersonaChange());
		this.renderPersonaSelect();

		const spacer = header.createDiv({ cls: "llm-header-spacer" });
		spacer.style.flex = "1";

		const sessionsBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Toggle sessions sidebar" } });
		setIcon(sessionsBtn, "panel-left");
		sessionsBtn.addEventListener("click", () => this.toggleSidebar());

		this.newBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "New session" } });
		setIcon(this.newBtn, "plus");
		this.newBtn.addEventListener("click", () => this.startNewSession());

		const saveBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Save chat as Markdown" } });
		setIcon(saveBtn, "save");
		saveBtn.addEventListener("click", () => this.saveChat());

		this.stopBtn = header.createEl("button", { cls: "llm-icon-btn llm-stop-btn", attr: { "aria-label": "Stop" } });
		setIcon(this.stopBtn, "square");
		this.stopBtn.hide();
		this.stopBtn.addEventListener("click", () => this.backend?.abort());

		if (this.plugin.isGitRepo()) {
			const gitBtn = header.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Git" } });
			setIcon(gitBtn, "git-branch");
			gitBtn.addEventListener("click", (e) => this.openGitMenu(e));
		}

		this.statusEl = this.mainEl.createDiv({ cls: "llm-status" });
	}

	private async onEngineChange(): Promise<void> {
		if (this.isBusy("switching engine")) {
			this.engineSelect.value = this.plugin.settings.engine;
			return;
		}
		const engine = this.engineSelect.value as "pi" | "claude";
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
				} catch (err: any) {
					new Notice(`Speichern fehlgeschlagen: ${err?.message ?? err}`);
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
		} catch (err: any) {
			new Notice(`Speichern fehlgeschlagen: ${err?.message ?? err}`);
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
		const wrap = this.mainEl.createDiv({ cls: "llm-input-row" });
		this.inputEl = wrap.createEl("textarea", {
			cls: "llm-input",
			attr: { placeholder: "Ask the agent about your wiki… (Enter to send, Shift+Enter for newline)", rows: "3" },
		});
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
				e.preventDefault();
				this.onSend();
			}
		});
		this.sendBtn = wrap.createEl("button", { cls: "llm-send-btn", text: "Send" });
		this.sendBtn.addEventListener("click", () => this.onSend());
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
		const persona = this.plugin.getSelectedPersona();
		const prompts = persona ? persona.prompts : this.plugin.getDefaultPrompts();
		if (prompts.length === 0) {
			this.quickBarEl.hide();
			return;
		}
		this.quickBarEl.show();
		for (const p of prompts) {
			const btn = this.quickBarEl.createEl("button", { cls: "llm-quick-btn", text: p.label });
			if (p.prompt) btn.setAttribute("aria-label", p.prompt);
			btn.addEventListener("click", () => {
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
		if (this.backend) return;
		const cwd = this.plugin.getWorkingDir();
		if (!cwd) {
			this.setStatus("Cannot resolve vault path — a local vault is required.", true);
			return;
		}

		const s = this.plugin.settings;
		const engine = s.engine;
		this.engineSelect.value = engine;
		this.renderPersonaSelect();
		this.renderQuickPrompts();

		// A selected persona replaces AGENTS.md as the system prompt for this session.
		// The persona / AGENTS.md prompt file already has the fixed instructions
		// (path:line linking, schema protocol) baked in — Claude only honors a
		// single append file, so we never pass a second one.
		const personaFile = this.plugin.resolvePersonaPromptFile();
		this.structuredResponse = this.plugin.getSelectedPersona()?.responseSchema === true;
		this.session.engine = engine;
		this.session.persona = s.selectedPersona;
		const resumeSessionId = this.session.engineSessionId;

		if (engine === "claude") {
			this.backend = new ClaudeBackend({
				claudePath: s.claudePath,
				cwd,
				model: s.claudeModel || "default",
				permissionMode: s.claudePermissionMode,
				agentsFile:
					personaFile ??
					this.plugin.resolveAgentsPromptFile() ??
					this.plugin.resolveFixedInstructionFile() ??
					undefined,
				agentsMode: s.claudeAgentsMode,
				resumeSessionId,
			});
		} else {
			// Disable pi's raw AGENTS.md auto-load and re-inject the frontmatter-stripped
			// version (plus the persona, if any) so pi never sees the prompts frontmatter.
			this.backend = new PiBackend({
				piPath: s.piPath,
				cwd,
				provider: s.provider || undefined,
				model: s.model || undefined,
				thinking: s.thinking,
				persistSession: s.persistSession,
				disableContextFiles: true,
				appendSystemPromptFiles: [this.plugin.resolveAgentsPromptFile(), personaFile].filter(
					(f): f is string => !!f
				),
				resumeSessionId,
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
		const btn = this.statusEl.createEl("button", { text: "Reconnect", cls: "llm-reconnect-btn" });
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

		const head = this.contextEl.createDiv({ cls: "llm-context-head" });
		const icon = head.createSpan({ cls: "llm-context-icon" });
		setIcon(icon, ctx.selection ? "text-quote" : "file-text");
		const pathEl = head.createSpan({ cls: "llm-context-path", text: ctx.pagePath });
		pathEl.setAttribute("aria-label", `Open ${ctx.pagePath}`);
		pathEl.addEventListener("click", () => {
			void this.app.workspace.openLinkText(ctx.pagePath, "", false);
		});
		const clear = head.createEl("button", { cls: "llm-context-clear", attr: { "aria-label": "Remove context" } });
		setIcon(clear, "x");
		clear.addEventListener("click", () => {
			this.pendingContext = null;
			this.renderPendingContext();
		});

		if (ctx.selection) {
			this.contextEl.createDiv({ cls: "llm-context-body", text: ctx.selection });
		}
	}

	private async startNewSession(): Promise<void> {
		if (this.isBusy("starting a new session")) return;
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
		this.session = this.makeSession();
		this.clearConversationDom();
		this.teardownBackend();
		await this.connect();
		this.renderSessionList();
		this.setStatus("New session.");
	}

	private async switchSession(id: string): Promise<void> {
		const target = this.plugin.sessionStore.get(id);
		if (!target || target.id === this.session.id) return;
		if (this.isBusy("switching sessions")) return;

		this.session = target;
		// Align engine + persona so the engine can resume the right conversation.
		this.plugin.settings.engine = target.engine;
		this.plugin.settings.selectedPersona = target.persona;
		await this.plugin.saveSettings();
		this.engineSelect.value = target.engine;

		this.clearConversationDom();
		this.renderTranscriptFromSession();
		this.teardownBackend();
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
		newBtn.addEventListener("click", () => void this.startNewSession());

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

	/** Rebuild the session list. The active session is always shown (even before
	 *  it is persisted), highlighted, newest first. */
	private renderSessionList(): void {
		if (!this.sessionListEl) return;
		this.sessionListEl.empty();

		const saved = this.plugin.sessionStore.getAll();
		const list = saved.some((s) => s.id === this.session.id) ? saved.slice() : [this.session, ...saved];

		if (list.length === 0) {
			this.sessionListEl.createDiv({ cls: "llm-session-empty", text: "No sessions yet." });
			return;
		}

		for (const s of list) {
			const active = s.id === this.session.id;
			const item = this.sessionListEl.createDiv({ cls: "llm-session-item" + (active ? " is-active" : "") });
			item.addEventListener("click", () => void this.switchSession(s.id));
			item.addEventListener("contextmenu", (e) => this.openSessionItemMenu(e, s.id));

			const body = item.createDiv({ cls: "llm-session-body" });
			body.createDiv({ cls: "llm-session-name", text: s.name || "New chat" });
			const meta = [this.plugin.engineLabel(), s.model].filter(Boolean).join(" · ");
			if (meta) body.createDiv({ cls: "llm-session-meta", text: meta });

			const actions = item.createDiv({ cls: "llm-session-actions" });
			const rename = actions.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Rename" } });
			setIcon(rename, "pencil");
			rename.addEventListener("click", (e) => {
				e.stopPropagation();
				void this.renameSession(s.id);
			});
			const del = actions.createEl("button", { cls: "llm-icon-btn", attr: { "aria-label": "Delete" } });
			setIcon(del, "trash");
			del.addEventListener("click", (e) => {
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
		if (this.isBusy("deleting the session")) return;
		this.plugin.sessionStore.remove(id);
		if (id === this.session.id) {
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
		const removed = this.plugin.sessionStore.keepOnly(keepId);
		// Keeping a non-active session deletes the active one — switch to the kept one.
		if (keepId !== this.session.id) {
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
			else this.renderAssistantBlock(m.text);
		}
	}

	/** Persist the current session after its transcript changed; name it lazily. */
	private afterTranscriptChange(): void {
		if (this.session.transcript.length === 0) return;
		if (!this.session.name) {
			const first = this.session.transcript.find((t) => t.role === "user")?.text ?? "New chat";
			this.session.name = first.split("\n").map((l) => l.trim()).filter(Boolean)[0]?.slice(0, 60) || "New chat";
		}
		this.session.model = this.modelSelect.selectedOptions[0]?.text || this.session.model;
		this.session.updatedAt = Date.now();
		this.plugin.sessionStore.upsert(this.session);
		this.renderSessionList();
	}

	private async captureSessionId(): Promise<void> {
		const sid = await this.backend?.getEngineSessionId();
		if (sid && sid !== this.session.engineSessionId) {
			this.session.engineSessionId = sid;
			if (this.session.transcript.length) this.plugin.sessionStore.upsert(this.session);
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
				this.runStartMs = Date.now();
				this.runTokens = 0;
				this.showWorking();
				this.startWorkingTimer();
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
				void this.captureSessionId();
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
		block.root.toggleClass("llm-tool-error", ev.isError);
		const badge = block.titleEl.querySelector(".llm-tool-status");
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
		const parts = [formatDuration(Math.floor((Date.now() - this.runStartMs) / 1000))];
		if (this.runTokens > 0) parts.push(`${formatTokens(this.runTokens)} tokens`);
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

	private appendUserMessage(text: string): void {
		this.session.transcript.push({ role: "user", text });
		this.renderUserBlock(text);
		this.afterTranscriptChange();
	}

	private renderUserBlock(text: string): void {
		const block = this.appendBlock("llm-msg llm-msg-user");
		const body = block.createDiv({ cls: "llm-msg-body" });
		this.renderMarkdownInto(body, text);
		this.scrollToBottom(true);
	}

	private renderAssistantBlock(text: string): void {
		const block = this.appendBlock("llm-msg llm-msg-assistant");
		const body = block.createDiv({ cls: "llm-msg-body" });
		this.renderMarkdownInto(body, text);
		this.scrollToBottom();
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

	private newToolBlock(toolName: string, args: any): ToolBlock {
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

	private renderMarkdownInto(el: HTMLElement, markdown: string): void {
		el.empty();
		void MarkdownRenderer.render(this.app, markdown, el, "", this).then(() => {
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
		body.empty();
		for (const env of envs) {
			if (env.text) {
				const textEl = body.createDiv({ cls: "llm-structured-text" });
				this.renderMarkdownInto(textEl, env.text);
			}
			if (env.type === "single_choice") {
				const ol = body.createEl("ol", { cls: "llm-options" });
				for (const opt of env.options) {
					const li = ol.createEl("li", { cls: "llm-option", text: opt });
					li.setAttribute("role", "button");
					li.setAttribute("tabindex", "0");
					const choose = () => this.chooseOption(ol, li, opt);
					li.addEventListener("click", choose);
					li.addEventListener("keydown", (e) => {
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
		this.scrollToBottom();
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
		send.addEventListener("click", () => {
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
		a.addEventListener("click", (e) => {
			e.preventDefault();
			const newLeaf: PaneType | boolean = e.ctrlKey || e.metaKey ? "tab" : false;
			void this.openPage(dest, line, newLeaf);
		});
		a.addEventListener("auxclick", (e) => {
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

	private finalizeText(): void {
		if (this.currentTextEl) {
			const envs = this.structuredResponse ? parseResponseEnvelopes(this.currentText) : [];
			if (envs.length) {
				this.renderStructuredInto(this.currentTextEl, envs);
				this.session.transcript.push({ role: "assistant", text: envelopesToTranscript(envs) });
				this.afterTranscriptChange();
			} else {
				// Plain message, or a structured persona whose output didn't parse —
				// fall back to rendering the raw text as markdown.
				this.renderMarkdownInto(this.currentTextEl, this.currentText);
				if (this.currentText.trim()) {
					this.session.transcript.push({ role: "assistant", text: this.currentText });
					this.afterTranscriptChange();
				}
			}
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
		this.statusEl.toggleClass("llm-status-error", isError);
	}

	private refreshSendState(): void {
		if (this.streaming) {
			this.stopBtn.show();
			this.sendBtn.setText("Steer");
		} else {
			this.stopBtn.hide();
			this.sendBtn.setText("Send");
		}
		// Can't start/replace a session mid-run — it would abort the response.
		this.newBtn.disabled = this.streaming;
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
		const el = this.transcriptEl;
		const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
		if (force || nearBottom) el.scrollTop = el.scrollHeight;
	}
}
