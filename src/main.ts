import { Editor, FileSystemAdapter, MarkdownFileInfo, Menu, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { PI_VIEW_TYPE, PiChatView } from "./chat-view";
import { DEFAULT_SETTINGS, PiAgentSettingTab, PiAgentSettings } from "./settings";
import { PromptStore } from "./prompts";
import * as path from "path";
import * as fs from "fs";

export default class PiAgentPlugin extends Plugin {
	declare settings: PiAgentSettings;
	promptStore!: PromptStore;

	// Auto-run batching: paths created in the watch folder, plus a debounce timer.
	private pendingAutoRun = new Set<string>();
	private autoRunTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.promptStore = new PromptStore(this.app, () => this.settings.promptsFile);
		await this.promptStore.load();

		// Live-reload standard prompts when the JSON file is edited in the vault.
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file.path === this.promptStore.fileName) void this.refreshPrompts();
			})
		);

		this.registerView(PI_VIEW_TYPE, (leaf: WorkspaceLeaf) => new PiChatView(leaf, this));

		this.addRibbonIcon("bot", "Open Pi Agent", () => this.activateView());

		this.addCommand({
			id: "open-pi-agent",
			name: "Open Pi Agent panel",
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: "pi-agent-new-session",
			name: "Pi Agent: new session",
			callback: async () => {
				const leaf = await this.activateView();
				if (leaf?.view instanceof PiChatView) {
					await leaf.view.newSessionCommand();
				}
			},
		});

		this.addCommand({
			id: "pi-agent-ask-about-selection",
			name: "Ask the agent about selection",
			editorCallback: (editor: Editor, info: MarkdownFileInfo) => {
				const selection = editor.getSelection();
				if (!selection || !selection.trim()) {
					new Notice("Select some text first.");
					return;
				}
				void this.askAboutSelection(info.file ?? null, selection);
			},
		});

		// Right-click context menu entry when text is selected in a note. The label
		// reflects the currently selected engine (pi / Claude Code).
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
				const selection = editor.getSelection();
				if (!selection || !selection.trim()) return;
				menu.addItem((item) =>
					item
						.setTitle(`Ask ${this.engineLabel()} about selection`)
						.setIcon("bot")
						.onClick(() => this.askAboutSelection(info.file ?? null, selection))
				);
			})
		);

		this.addSettingTab(new PiAgentSettingTab(this.app, this));

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
		// Views are detached by Obsidian; PiChatView.onClose disposes its backend.
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

		const leaf = await this.activateView();
		if (leaf?.view instanceof PiChatView) {
			await leaf.view.runPrompt(prompt);
		}
	}

	/** Convert a vault-relative path to one relative to the agent's working dir. */
	private toAgentPath(vaultPath: string): string {
		const sub = this.settings.workingDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
		if (sub && vaultPath.startsWith(sub + "/")) return vaultPath.slice(sub.length + 1);
		return vaultPath;
	}

	async activateView(): Promise<WorkspaceLeaf | null> {
		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(PI_VIEW_TYPE)[0] ?? null;
		if (!leaf) {
			const right: WorkspaceLeaf | null = workspace.getRightLeaf(false);
			if (right) await right.setViewState({ type: PI_VIEW_TYPE, active: true });
			leaf = right;
		}
		if (leaf) workspace.revealLeaf(leaf);
		return leaf;
	}

	/** Display name for the currently selected engine. */
	engineLabel(): string {
		return this.settings.engine === "claude" ? "Claude Code" : "pi";
	}

	/** Open the panel and seed a fresh session with a page selection to ask about. */
	private async askAboutSelection(file: TFile | null, selection: string): Promise<void> {
		const pagePath = file ? this.toAgentPath(file.path) : "(unknown page)";
		const leaf = await this.activateView();
		if (leaf?.view instanceof PiChatView) {
			await leaf.view.seedFromSelection(pagePath, selection);
		}
	}

	/**
	 * Absolute path pi should run in: the vault root, optionally narrowed to a
	 * configured subfolder. Returns null if the vault is not on the local
	 * filesystem (pi cannot operate on it).
	 */
	getWorkingDir(): string | null {
		const adapter = this.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		const base = adapter.getBasePath();
		const sub = this.settings.workingDir?.trim();
		return sub ? path.join(base, sub) : base;
	}

	/** Reload prompts from the vault file and update any open panels. */
	async refreshPrompts(): Promise<void> {
		await this.promptStore.load();
		this.refreshOpenViews();
	}

	/** Tell every open Pi panel to rebuild its quick-prompt bar. */
	refreshOpenViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(PI_VIEW_TYPE)) {
			if (leaf.view instanceof PiChatView) leaf.view.reloadPrompts();
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

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
