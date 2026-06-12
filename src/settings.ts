import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type PiAgentPlugin from "./main";
import { ThinkingLevel } from "./rpc-types";
import { StandardPrompt, makeId } from "./prompts";

export interface PiAgentSettings {
	/** Command or absolute path used to launch pi. */
	piPath: string;
	/**
	 * Working directory for pi, relative to the vault root. Empty string means
	 * the vault root itself (where AGENTS.md lives). pi reads AGENTS.md and
	 * operates on files starting from here.
	 */
	workingDir: string;
	/** Default provider (e.g. "anthropic"). Empty = pi's own default. */
	provider: string;
	/** Default model pattern/id (e.g. "claude-opus-4-8"). Empty = pi's default. */
	model: string;
	/** Reasoning effort. */
	thinking: ThinkingLevel;
	/** Persist sessions to disk so they can be resumed later. */
	persistSession: boolean;
	/** Show the agent's thinking blocks in the chat. */
	showThinking: boolean;
	/**
	 * How to handle tool-permission / confirmation dialogs raised by pi
	 * extensions: ask the user, always allow, or always block.
	 */
	dialogPolicy: "ask" | "allow" | "block";
	/** Name of the JSON file (at the vault root) holding standard prompts. */
	promptsFile: string;
}

export const DEFAULT_SETTINGS: PiAgentSettings = {
	piPath: "pi",
	workingDir: "",
	provider: "",
	model: "",
	thinking: "medium",
	persistSession: true,
	showThinking: false,
	dialogPolicy: "ask",
	promptsFile: "pi-agent-prompts.json",
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export class PiAgentSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: PiAgentPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Pi Agent" });
		containerEl.createEl("p", {
			text:
				"Pi runs as a background process scoped to your vault. It reads the vault's AGENTS.md and can read, create, and edit your wiki pages. Restart the chat panel (or reopen it) after changing these settings.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Pi command")
			.setDesc("Command or absolute path used to launch pi. Must be on PATH, or give a full path (e.g. C:\\Users\\you\\AppData\\Roaming\\npm\\pi.cmd).")
			.addText((t) =>
				t
					.setPlaceholder("pi")
					.setValue(this.plugin.settings.piPath)
					.onChange(async (v) => {
						this.plugin.settings.piPath = v.trim() || "pi";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Working directory")
			.setDesc("Folder pi operates in, relative to the vault root. Leave empty to use the vault root (where AGENTS.md lives).")
			.addText((t) =>
				t
					.setPlaceholder("(vault root)")
					.setValue(this.plugin.settings.workingDir)
					.onChange(async (v) => {
						this.plugin.settings.workingDir = v.trim().replace(/^[\\/]+/, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default provider")
			.setDesc("Optional. Provider passed to pi at startup (e.g. anthropic, openai, google). Leave empty for pi's default.")
			.addText((t) =>
				t
					.setPlaceholder("(pi default)")
					.setValue(this.plugin.settings.provider)
					.onChange(async (v) => {
						this.plugin.settings.provider = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default model")
			.setDesc("Optional. Model id/pattern passed to pi at startup (e.g. claude-opus-4-8). You can also switch models live from the panel.")
			.addText((t) =>
				t
					.setPlaceholder("(pi default)")
					.setValue(this.plugin.settings.model)
					.onChange(async (v) => {
						this.plugin.settings.model = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Thinking level")
			.setDesc("Reasoning effort for models that support it.")
			.addDropdown((d) => {
				for (const lvl of THINKING_LEVELS) d.addOption(lvl, lvl);
				d.setValue(this.plugin.settings.thinking).onChange(async (v) => {
					this.plugin.settings.thinking = v as ThinkingLevel;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Persist sessions")
			.setDesc("Save conversations to pi's session store so they can be resumed. Turn off for ephemeral chats.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.persistSession).onChange(async (v) => {
					this.plugin.settings.persistSession = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Show thinking")
			.setDesc("Display the agent's reasoning blocks in the chat panel.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showThinking).onChange(async (v) => {
					this.plugin.settings.showThinking = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Tool permission dialogs")
			.setDesc("How to handle confirmation prompts raised by pi (e.g. before running a shell command).")
			.addDropdown((d) => {
				d.addOption("ask", "Ask me each time");
				d.addOption("allow", "Always allow");
				d.addOption("block", "Always block");
				d.setValue(this.plugin.settings.dialogPolicy).onChange(async (v) => {
					this.plugin.settings.dialogPolicy = v as PiAgentSettings["dialogPolicy"];
					await this.plugin.saveSettings();
				});
			});

		// ----- standard prompts -----
		containerEl.createEl("h3", { text: "Standard prompts" });
		containerEl.createEl("p", {
			text:
				"One-click prompts shown as buttons in the panel. Stored as JSON in your vault root — you can also edit that file directly.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Prompts file")
			.setDesc("File name (relative to the vault root) where standard prompts are stored.")
			.addText((t) =>
				t
					.setPlaceholder("pi-agent-prompts.json")
					.setValue(this.plugin.settings.promptsFile)
					.onChange(async (v) => {
						this.plugin.settings.promptsFile = v.trim() || "pi-agent-prompts.json";
						await this.plugin.saveSettings();
					})
			)
			.addExtraButton((b) =>
				b
					.setIcon("refresh-cw")
					.setTooltip("Reload from file")
					.onClick(async () => {
						await this.plugin.refreshPrompts();
						this.display();
					})
			);

		const listEl = containerEl.createDiv({ cls: "pi-prompts-settings" });
		void this.renderPromptList(listEl);
	}

	private async renderPromptList(containerEl: HTMLElement): Promise<void> {
		containerEl.empty();
		const store = this.plugin.promptStore;
		if (!store.isLoaded()) await store.load();
		const prompts = store.getAll();

		if (prompts.length === 0) {
			containerEl.createEl("p", {
				text: "No standard prompts yet.",
				cls: "setting-item-description",
			});
		}

		prompts.forEach((p, index) => {
			const row = containerEl.createDiv({ cls: "pi-prompt-edit" });

			new Setting(row)
				.setName(`Prompt ${index + 1}`)
				.addText((t) =>
					t
						.setPlaceholder("Button label")
						.setValue(p.label)
						.onChange((v) => {
							p.label = v;
						})
				)
				.addExtraButton((b) =>
					b
						.setIcon("trash")
						.setTooltip("Delete")
						.onClick(async () => {
							const next = prompts.filter((x) => x.id !== p.id);
							await this.persist(next);
							await this.renderPromptList(containerEl);
						})
				);

			const ta = row.createEl("textarea", {
				cls: "pi-prompt-text",
				attr: { rows: "3", placeholder: "Prompt text sent to pi…" },
			});
			ta.value = p.prompt;
			ta.addEventListener("change", () => {
				p.prompt = ta.value;
			});
		});

		const actions = containerEl.createDiv({ cls: "pi-prompts-actions" });

		const addBtn = actions.createEl("button", { text: "Add prompt" });
		addBtn.addEventListener("click", async () => {
			const next: StandardPrompt[] = [
				...prompts,
				{ id: makeId(), label: "New prompt", prompt: "" },
			];
			await this.persist(next);
			await this.renderPromptList(containerEl);
		});

		const saveBtn = actions.createEl("button", { cls: "mod-cta", text: "Save prompts" });
		saveBtn.addEventListener("click", async () => {
			await this.persist(prompts);
			new Notice("Standard prompts saved.");
		});
	}

	private async persist(prompts: StandardPrompt[]): Promise<void> {
		await this.plugin.promptStore.save(prompts);
		this.plugin.refreshOpenViews();
	}
}
