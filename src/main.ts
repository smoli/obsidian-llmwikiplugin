import { Editor, FileSystemAdapter, MarkdownFileInfo, MarkdownView, Menu, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { VIEW_TYPE, LlmChatView } from "./chat-view";
import { DEFAULT_SETTINGS, LlmAgentSettingTab, LlmAgentSettings } from "./settings";
import { SessionStore, SavedSession, newSessionId } from "./sessions";
import { SessionManager } from "./session-runtime";
import { loginOpenAiCodex, refreshOpenAiCodex } from "./openai-oauth";
import { loadSecrets, saveSecrets } from "./secrets";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

/** A reusable, one-click prompt shown as a button in the panel. */
export interface QuickPrompt {
	label: string;
	prompt: string;
}

export interface Persona {
	path: string;
	name: string;
	/** When true, the agent is asked to reply with a structured response envelope. */
	responseSchema?: boolean;
	/**
	 * When true, the persona is meant to operate on the whole vault, so it is not
	 * offered in the "Ask … about selection/page" context menu.
	 */
	wholeVault?: boolean;
	/** Skill names (→ `skills/<name>.md`) injected into this persona's system prompt. */
	skills: string[];
	/** Whether the core AGENTS.md is prepended (default true; `baseAgents: false` opts out). */
	baseAgents: boolean;
	/** One-click prompts declared in the persona's frontmatter. */
	prompts: QuickPrompt[];
}

/** Parse a frontmatter `skills:` value (a YAML list, or a comma-separated string). */
function parseSkillList(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map((s) => String(s).trim().replace(/\.md$/i, "")).filter(Boolean);
	if (typeof raw === "string") return raw.split(",").map((s) => s.trim().replace(/\.md$/i, "")).filter(Boolean);
	return [];
}

/** Remove a leading YAML frontmatter block (`---` … `---`) from markdown. */
function stripFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/**
 * Parse a frontmatter `prompts:` list into QuickPrompts (used by both personas
 * and the Default-mode AGENTS.md). Tolerant of the forms a file may carry:
 *  - a plain string `"Label | Prompt text"` (preferred — stays editable in
 *    Obsidian's Properties UI as a list of text items),
 *  - a plain string with no `|` (used as both label and prompt),
 *  - a `{label, prompt}` object,
 *  - a JSON-string object (Obsidian rewrites nested objects to JSON strings).
 */
function parseQuickPrompts(raw: unknown): QuickPrompt[] {
	if (!Array.isArray(raw)) return [];
	const out: QuickPrompt[] = [];
	for (const item of raw) {
		let value: unknown = item;
		if (typeof item === "string") {
			const s = item.trim();
			if (!s) continue;
			// Obsidian may have stored a {label,prompt} object as a JSON string.
			if (s.startsWith("{")) {
				try {
					value = JSON.parse(s);
				} catch {
					value = s;
				}
			} else {
				value = s;
			}
		}

		if (typeof value === "string") {
			const sep = value.indexOf("|");
			if (sep === -1) {
				out.push({ label: value.length > 40 ? value.slice(0, 40) + "…" : value, prompt: value });
			} else {
				const label = value.slice(0, sep).trim();
				const prompt = value.slice(sep + 1).trim();
				if (label || prompt) out.push({ label: label || prompt.slice(0, 40), prompt: prompt || label });
			}
			continue;
		}

		if (!value || typeof value !== "object") continue;
		const o = value as Record<string, unknown>;
		const prompt = typeof o.prompt === "string" ? o.prompt : typeof o.text === "string" ? o.text : "";
		const label = typeof o.label === "string" && o.label.trim() ? o.label.trim() : prompt.trim().slice(0, 40);
		if (!label && !prompt) continue;
		out.push({ label: label || "(unnamed)", prompt });
	}
	return out;
}

/**
 * Appended to a persona's system prompt when it opts into structured responses
 * (frontmatter `responseSchema: true`). It constrains every user-facing message
 * to a small JSON envelope the chat view can render as text, a single-choice
 * question, or a multiple-choice question.
 */
export const RESPONSE_SCHEMA_INSTRUCTION = `

## Response format (STRICT)

Structure every reply to the user as one or more blocks. Begin each block with a
marker line of the form ">>> <type>" on its own line, followed by its content on
the next lines. Do not use JSON and do not wrap blocks in code fences.

The three block types:

>>> message
<your message — ordinary markdown; multiple lines, quotes, and punctuation are all fine>

>>> single_choice
<the question — markdown allowed>
- <option 1>
- <option 2>

>>> multi_choice
<the question — markdown allowed>
- <option 1>
- <option 2>

Rules:
- Start every block with its ">>> <type>" marker line. Write the content plainly
  underneath — no escaping, no quoting of the whole text.
- For single_choice / multi_choice, put the question text first, then list each
  option on its own line starting with "- ". Keep options short.
- Use single_choice when exactly ONE answer fits, multi_choice when SEVERAL may
  fit, and message for anything that isn't a choice.
- A reply may combine blocks (e.g. a "message" with feedback, then a
  "single_choice" with the next question). End a reply with at most one choice
  block.
- After the user answers, their next message contains the chosen option text(s) —
  continue normally in this same format.
- You may still use your tools as needed; this format applies only to the
  messages you address to the user.`;

/**
 * Always appended to the system prompt (both engines, every session). Lets the
 * agent point the user at exact spots: the chat panel turns `path:line`
 * references into links that open the page scrolled to that line.
 */
export const WIKI_LINE_LINK_INSTRUCTION = `## Pointing at lines

When you reference a vault page in your reply — especially to point at a change
you just made — and you know the relevant line number, write the reference as
\`pagepath:line\` (e.g. \`05-wiki/foo/bar.md:128\`), or \`pagepath:start-end\` for a
range. The panel turns these into links that jump straight to that line. Only add
a line number when you are confident it is accurate for the current file; if you
are unsure, reference the page path without a line.`;

export default class LlmAgentPlugin extends Plugin {
	declare settings: LlmAgentSettings;
	sessionStore!: SessionStore;
	sessionManager!: SessionManager;

	// Auto-run batching: paths created in the watch folder, plus a debounce timer.
	private pendingAutoRun = new Set<string>();
	private autoRunTimer: number | null = null;
	// Debounce for auto-attaching the editor selection to chat panels.
	private selectionTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
		this.sessionStore = new SessionStore(this.app, pluginDir);
		await this.sessionStore.load();
		this.sessionManager = new SessionManager(this);

		// Personas (and their one-click prompts) live in vault-root markdown
		// frontmatter; rebuild open panels' persona dropdown + quick-prompt bar
		// whenever a file's metadata changes.
		this.registerEvent(
			this.app.metadataCache.on("changed", (file: TFile) => {
				if (!file.path.includes("/") || file.name === "AGENTS.md") this.refreshOpenViews();
			})
		);

		this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new LlmChatView(leaf, this));

		this.addRibbonIcon("bot", "Open STS-LLM Wiki", () => this.activateView());

		this.addCommand({
			id: "open-llm-agent",
			name: "Open panel",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "llm-agent-new-session",
			name: "New session",
			callback: async () => {
				const leaf = await this.activateView();
				if (leaf?.view instanceof LlmChatView) {
					await leaf.view.newSessionCommand();
				}
			},
		});

		this.addCommand({
			id: "llm-agent-ask-about-selection",
			name: "Ask the agent about selection or page",
			editorCallback: (editor: Editor, info: MarkdownFileInfo) => {
				const selection = editor.getSelection();
				const sel = selection && selection.trim() ? selection : undefined;
				void this.askAbout(info.file ?? null, sel);
			},
		});

		// Right-click context menu entry: "about selection" when text is selected,
		// otherwise "about this page". The label reflects the active engine.
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
				const selection = editor.getSelection();
				const sel = selection && selection.trim() ? selection : undefined;
				const file = info.file ?? null;
				if (!sel && !file) return;
				const target = sel ? "selection" : "this page";
				const engine = this.engineLabel();
				// Original entry: always uses the vault's AGENTS.md (persona "").
				menu.addItem((item) =>
					item
						.setTitle(`Ask ${engine} about ${target}`)
						.setIcon("bot")
						.onClick(() => this.askAbout(file, sel, ""))
				);
				// One entry per persona, auto-selecting it in the created chat.
				// Whole-vault personas are skipped — they don't act on a selection/page.
				for (const p of this.getPersonas()) {
					if (p.wholeVault) continue;
					menu.addItem((item) =>
						item
							.setTitle(`Ask ${engine} about ${target} as ${p.name}`)
							.setIcon("bot")
							.onClick(() => this.askAbout(file, sel, p.path))
					);
				}
			})
		);

		this.addSettingTab(new LlmAgentSettingTab(this.app, this));

		// Optional: mirror the editor selection into open chat panels as a context
		// chip, debounced so a drag-select doesn't fire on every change.
		this.registerDomEvent(document, "selectionchange", () => this.onSelectionChange());

		// Register the folder watcher only after layout is ready. Obsidian replays
		// a "create" event for every existing file during startup; waiting for
		// layout-ready skips that initial flood so we only react to genuinely new files.
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("create", (file) => this.onVaultCreate(file)));
		});
	}

	onunload(): void {
		if (this.autoRunTimer != null) {
			window.clearTimeout(this.autoRunTimer);
			this.autoRunTimer = null;
		}
		if (this.selectionTimer != null) {
			window.clearTimeout(this.selectionTimer);
			this.selectionTimer = null;
		}
		this.sessionManager?.disposeAll();
		// Views are detached by Obsidian; LlmChatView.onClose disposes its backend.
	}

	// ------------------------------------------------ auto-attach editor selection

	private onSelectionChange(): void {
		if (!this.settings.autoAttachSelection) return;
		if (this.selectionTimer != null) window.clearTimeout(this.selectionTimer);
		this.selectionTimer = window.setTimeout(() => {
			this.selectionTimer = null;
			this.attachActiveSelection();
		}, 350);
	}

	/**
	 * Mirror the active note's selection into open chat panels. A non-empty
	 * selection sets the chip; clearing the selection *while the note is still the
	 * active view* removes an auto-attached chip. If the active view isn't a note
	 * (e.g. the user moved to the chat to type), nothing changes — the chip stays.
	 */
	private attachActiveSelection(): void {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!view || !view.file) return;
		const sel = view.editor?.getSelection?.() ?? "";
		const pagePath = this.toAgentPath(view.file.path);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (!(leaf.view instanceof LlmChatView)) continue;
			if (sel.trim()) leaf.view.setSelectionContext(pagePath, sel);
			else leaf.view.clearSelectionContext();
		}
	}

	// ----------------------------------------------------- folder-watch auto-run

	private onVaultCreate(file: TAbstractFile): void {
		if (!this.settings.autoRunEnabled) return;
		if (!(file instanceof TFile)) return;

		const folder = this.settings.autoRunFolder.replace(/^[\\/]+|[\\/]+$/g, "");
		if (!folder) return;

		const p = file.path; // vault-relative, forward slashes
		if (p !== folder && !p.startsWith(folder + "/")) return;

		this.pendingAutoRun.add(this.toAgentPath(p));
		if (this.autoRunTimer != null) window.clearTimeout(this.autoRunTimer);
		this.autoRunTimer = window.setTimeout(() => {
			this.autoRunTimer = null;
			void this.dispatchAutoRun();
		}, 1500);
	}

	private async dispatchAutoRun(): Promise<void> {
		const files = [...this.pendingAutoRun];
		this.pendingAutoRun.clear();
		if (files.length === 0) return;

		const list = files.map((f) => `- ${f}`).join("\n");
		const prompt = (this.settings.autoRunPrompt || DEFAULT_SETTINGS.autoRunPrompt)
			.replace(/\{\{files\}\}/g, list)
			.replace(/\{\{count\}\}/g, String(files.length));

		await this.runAutomationSession(prompt);
	}

	/**
	 * Run an automation prompt in its **own background session/runtime** — it does
	 * not wait for, switch to, or disturb the foreground session. The new session
	 * appears in the sidebar (streaming dot), ready to open when convenient.
	 */
	private async runAutomationSession(prompt: string): Promise<void> {
		const now = Date.now();
		const session: SavedSession = {
			id: newSessionId(),
			name: "",
			engine: this.settings.engine,
			engineSessionId: undefined,
			model: "",
			persona: this.settings.autoRunPersona,
			transcript: [],
			createdAt: now,
			updatedAt: now,
		};
		this.sessionStore.upsert(session);

		const runtime = this.sessionManager.acquire(session);
		const err = runtime.start();
		if (err) {
			new Notice(`Automation: ${err}`);
			return;
		}
		// Wait briefly for the engine process to come up before prompting.
		for (let i = 0; i < 50 && !runtime.running; i++) {
			await new Promise((r) => window.setTimeout(r, 200));
		}
		if (!runtime.running) {
			new Notice("Automation: the agent did not start.");
			return;
		}
		await runtime.prompt(prompt, false);
		this.sessionManager.enforceCap();

		// Surface it (open the panel if needed) without switching the active session.
		void this.activateView();
		this.refreshSessionLists();
	}

	/** Convert a vault-relative path to one relative to the agent's working dir. */
	private toAgentPath(vaultPath: string): string {
		const sub = this.settings.workingDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (sub && vaultPath.startsWith(sub + "/")) return vaultPath.slice(sub.length + 1);
		return vaultPath;
	}

	async activateView(): Promise<WorkspaceLeaf | null> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			const right: WorkspaceLeaf | null = workspace.getRightLeaf(false);
			if (right) await right.setViewState({ type: VIEW_TYPE, active: true });
			leaf = right;
		}
		if (leaf) workspace.revealLeaf(leaf);
		return leaf;
	}

	/** Run the ChatGPT (Codex) OAuth login and store the credentials. */
	async loginOpenAi(): Promise<boolean> {
		try {
			const creds = await loginOpenAiCodex((url) => {
				try {
					(window as unknown as { require?: (m: string) => { shell?: { openExternal?: (u: string) => void } } })
						.require?.("electron")
						?.shell?.openExternal?.(url);
				} catch {
					/* fall back to clipboard below */
				}
				try {
					void navigator.clipboard?.writeText(url);
				} catch {
					/* ignore */
				}
				new Notice("Opening browser for ChatGPT sign-in… (the login URL was copied to your clipboard).");
			});
			this.settings.openaiOAuth = creds;
			await this.saveSettings();
			new Notice("Signed in to ChatGPT.");
			return true;
		} catch (err) {
			new Notice(`ChatGPT sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	async logoutOpenAi(): Promise<void> {
		this.settings.openaiOAuth = null;
		await this.saveSettings();
	}

	/** Refresh the stored ChatGPT token; returns the fresh token or null. */
	async refreshOpenAiToken(): Promise<{ accessToken: string; accountId: string } | null> {
		const o = this.settings.openaiOAuth;
		if (!o) return null;
		try {
			const creds = await refreshOpenAiCodex(o.refresh);
			this.settings.openaiOAuth = creds;
			await this.saveSettings();
			return { accessToken: creds.access, accountId: creds.accountId };
		} catch {
			return null;
		}
	}

	/** Display name for the currently selected engine. */
	engineLabel(): string {
		switch (this.settings.engine) {
			case "claude":
				return "Claude Code";
			case "openai":
				return "OpenAI";
			default:
				return "pi";
		}
	}

	/** Open the panel and seed a fresh session with a page (and optional selection). */
	private async askAbout(file: TFile | null, selection?: string, persona = ""): Promise<void> {
		if (!file && !selection) {
			new Notice("Open a note or select some text first.");
			return;
		}
		const pagePath = file ? this.toAgentPath(file.path) : "(unknown page)";
		const leaf = await this.activateView();
		if (leaf?.view instanceof LlmChatView) {
			await leaf.view.seedContext(pagePath, selection, persona);
		}
	}

	/**
	 * Absolute path pi should run in: the vault root, optionally narrowed to a
	 * configured subfolder. Returns null if the vault is not on the local
	 * filesystem (pi cannot operate on it).
	 */
	getWorkingDir(): string | null {
		const base = this.getVaultBase();
		if (!base) return null;
		const sub = this.settings.workingDir?.trim();
		return sub ? path.join(base, sub) : base;
	}

	/** Absolute path to the vault root, or null if the vault isn't on disk. */
	getVaultBase(): string | null {
		const adapter = this.app.vault.adapter;
		return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null;
	}

	/** Markdown files in the vault root whose frontmatter has PERSONA: true. */
	getPersonas(): Persona[] {
		const out: Persona[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (f.path.includes("/")) continue; // root only
			const fm = this.app.metadataCache.getFileCache(f)?.frontmatter as Record<string, unknown> | undefined;
			if (!fm) continue;
			const flag = fm.PERSONA ?? fm.persona;
			if (flag === true || flag === "true") {
				const name =
					(typeof fm.name === "string" && fm.name) ||
					(typeof fm.title === "string" && fm.title) ||
					f.basename;
				const schema = fm.responseSchema ?? fm.response_schema ?? fm.RESPONSE_SCHEMA;
				const responseSchema = schema === true || schema === "true";
				const vault = fm.wholeVault ?? fm.whole_vault ?? fm.vaultOnly;
				const wholeVault = vault === true || vault === "true";
				const skills = parseSkillList(fm.skills);
				const baseRaw = fm.baseAgents ?? fm.base_agents ?? fm.includeAgents;
				const baseAgents = !(baseRaw === false || baseRaw === "false");
				const prompts = parseQuickPrompts(fm.prompts);
				out.push({ path: f.path, name, responseSchema, wholeVault, skills, baseAgents, prompts });
			}
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	}

	/** The Persona object for a vault-relative persona path, or null. */
	getPersonaByPath(personaPath: string): Persona | null {
		if (!personaPath) return null;
		return this.getPersonas().find((p) => p.path === personaPath) ?? null;
	}

	/** The Persona object for the globally selected persona, or null. */
	getSelectedPersona(): Persona | null {
		return this.getPersonaByPath(this.settings.selectedPersona);
	}

	/**
	 * Quick prompts for Default (AGENTS.md) mode, read from the working-dir
	 * AGENTS.md frontmatter `prompts:` list. Empty if there's no AGENTS.md or no
	 * prompts declared.
	 */
	getDefaultPrompts(): QuickPrompt[] {
		const sub = this.settings.workingDir?.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		const rel = sub ? `${sub}/AGENTS.md` : "AGENTS.md";
		const file = this.app.vault.getAbstractFileByPath(rel);
		if (!(file instanceof TFile)) return [];
		const fm = this.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
		return parseQuickPrompts(fm?.prompts);
	}

	/**
	 * Assemble the full system prompt for a session into a single temp file, in
	 * order: core AGENTS.md + the selected persona's body + its declared skills +
	 * the fixed instructions (and the response-schema protocol if the persona opts
	 * in). Personas *augment* the core rather than replacing it; a persona can set
	 * `baseAgents: false` to drop the core. Used by all three engines (Claude only
	 * honors one append file, so everything is combined here). Returns null when
	 * there is nothing to write.
	 */
	assembleSystemPromptFile(personaPath: string): string | null {
		const persona = this.getPersonaByPath(personaPath);
		const parts: string[] = [];

		// 1. Core AGENTS.md (unless the persona opts out).
		if (!persona || persona.baseAgents) {
			const core = this.readStripped(this.getAgentsFile());
			if (core) parts.push(core);
		}

		// 2. Persona body.
		if (personaPath) {
			const base = this.getVaultBase();
			const body = base ? this.readStripped(path.join(base, personaPath)) : "";
			if (body) parts.push(body);
		}

		// 3. Declared skills, each tagged so the model (and debug log) sees its source.
		for (const file of this.resolveSkillFiles(persona?.skills ?? [])) {
			const text = this.readStripped(file);
			if (text) parts.push(`<!-- skill: ${path.basename(file)} -->\n${text}`);
		}

		// 4. Fixed instructions + optional structured-response protocol.
		parts.push(WIKI_LINE_LINK_INSTRUCTION);
		if (persona?.responseSchema) parts.push(RESPONSE_SCHEMA_INSTRUCTION.trim());

		const content = parts.join("\n\n---\n\n").trim();
		if (!content) return null;
		try {
			const slug = personaPath ? personaPath.replace(/[^a-zA-Z0-9]+/g, "-") : "default";
			const tmp = path.join(os.tmpdir(), `llm-agent-sys-${slug}.md`);
			fs.writeFileSync(tmp, content + "\n", "utf8");
			return tmp;
		} catch {
			return null;
		}
	}

	/** Read a file and strip its YAML frontmatter; "" on any error or missing file. */
	private readStripped(file: string | null): string {
		if (!file) return "";
		try {
			return stripFrontmatter(fs.readFileSync(file, "utf8"));
		} catch {
			return "";
		}
	}

	/**
	 * Resolve declared skill names to existing `<skillsFolder>/<name>.md` absolute
	 * paths under the working dir. Missing skills are flagged (a typo shouldn't
	 * silently drop instructions) but don't abort the rest.
	 */
	resolveSkillFiles(names: string[]): string[] {
		const base = this.getWorkingDir();
		if (!base || names.length === 0) return [];
		const folder = (this.settings.skillsFolder || "skills").trim().replace(/^[\\/]+|[\\/]+$/g, "");
		const files: string[] = [];
		for (const name of names) {
			const abs = path.join(base, folder, `${name}.md`);
			if (fs.existsSync(abs)) files.push(abs);
			else new Notice(`Skill nicht gefunden: ${folder}/${name}.md`);
		}
		return files;
	}

	/** Tell every open STS-LLM Wiki panel to rebuild its persona dropdown + prompts. */
	refreshOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof LlmChatView) leaf.view.reloadPersonas();
		}
	}

	/** Tell every open panel to rebuild its session sidebar (status badges, names). */
	refreshSessionLists(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
			if (leaf.view instanceof LlmChatView) leaf.view.reloadSessionList();
		}
	}

	/** Whether the working directory is (inside) a git repository. */
	isGitRepo(): boolean {
		const cwd = this.getWorkingDir();
		if (!cwd) return false;
		try {
			return fs.existsSync(path.join(cwd, ".git"));
		} catch {
			return false;
		}
	}

	/** Absolute path to the working directory's AGENTS.md, if it exists. */
	getAgentsFile(): string | null {
		const cwd = this.getWorkingDir();
		if (!cwd) return null;
		const p = path.join(cwd, "AGENTS.md");
		try {
			return fs.existsSync(p) ? p : null;
		} catch {
			return null;
		}
	}

	/** Contents of the working directory's AGENTS.md (frontmatter stripped), or "". */
	getAgentsContent(): string {
		const p = this.getAgentsFile();
		if (!p) return "";
		try {
			return stripFrontmatter(fs.readFileSync(p, "utf8"));
		} catch {
			return "";
		}
	}

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<LlmAgentSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

		// Secrets live outside the vault (see secrets.ts). Overlay them, and migrate
		// any key/token that an older build wrote into data.json out of the vault.
		const secrets = loadSecrets();
		const leakedKey = data?.openaiApiKey || data?.openaiOAuth;
		if (data?.openaiApiKey && !secrets.openaiApiKey) secrets.openaiApiKey = data.openaiApiKey;
		if (data?.openaiOAuth && !secrets.openaiOAuth) secrets.openaiOAuth = data.openaiOAuth;
		if (leakedKey) saveSecrets(secrets);

		this.settings.openaiApiKey = secrets.openaiApiKey ?? "";
		this.settings.openaiOAuth = secrets.openaiOAuth ?? null;

		// Rewrite data.json without the secrets if they were ever stored there.
		if (leakedKey) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		// Secrets go to the home-dir file, never into the vault's data.json.
		saveSecrets({
			openaiApiKey: this.settings.openaiApiKey || undefined,
			openaiOAuth: this.settings.openaiOAuth ?? null,
		});
		const persisted = { ...this.settings } as Partial<LlmAgentSettings>;
		delete persisted.openaiApiKey;
		delete persisted.openaiOAuth;
		await this.saveData(persisted);
	}
}
