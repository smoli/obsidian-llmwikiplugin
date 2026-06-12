import { App, PluginSettingTab, Setting } from "obsidian";
import type PiAgentPlugin from "./main";
import { ThinkingLevel } from "./rpc-types";

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
	}
}
