import { FileSystemAdapter, Plugin, TAbstractFile, WorkspaceLeaf } from "obsidian";
import { PI_VIEW_TYPE, PiChatView } from "./chat-view";
import { DEFAULT_SETTINGS, PiAgentSettingTab, PiAgentSettings } from "./settings";
import { PromptStore } from "./prompts";
import * as path from "path";

export default class PiAgentPlugin extends Plugin {
	declare settings: PiAgentSettings;
	promptStore!: PromptStore;

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

		this.addSettingTab(new PiAgentSettingTab(this.app, this));
	}

	onunload(): void {
		// Views are detached by Obsidian; PiChatView.onClose disposes its client.
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

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}
