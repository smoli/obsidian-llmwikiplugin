import { App, PluginSettingTab, Setting } from "obsidian";
import type LlmAgentPlugin from "./main";
import { ThinkingLevel } from "./rpc-types";

export interface LlmAgentSettings {
	/** Which agent engine to drive: pi or the Claude Code CLI. */
	engine: "pi" | "claude";
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

	// --- Automation: run a prompt when files land in a watched folder ---
	/** Enable auto-running a prompt when new files appear in the watch folder. */
	autoRunEnabled: boolean;
	/** Vault-relative folder to watch for new files (e.g. "99-raw"). */
	autoRunFolder: string;
	/** Prompt to run; supports {{files}} (newline list) and {{count}} placeholders. */
	autoRunPrompt: string;

	// --- Claude Code engine ---
	/** Command or absolute path used to launch the Claude Code CLI. */
	claudePath: string;
	/** Permission handling for Claude Code's tools in the vault. */
	claudePermissionMode: "bypassPermissions" | "acceptEdits" | "default";
	/** Model for Claude Code: "default" | "opus" | "sonnet" | "haiku" | explicit id. */
	claudeModel: string;
	/** Whether AGENTS.md appends to or replaces Claude Code's system prompt. */
	claudeAgentsMode: "append" | "replace";

	/** Pre-fill the commit dialog with an engine-generated message. */
	gitSuggestCommitMessage: boolean;

	/** Vault-relative path of the selected persona file, or "" for AGENTS.md. */
	selectedPersona: string;

	/** Vault-relative folder where saved chats are written. */
	chatSaveFolder: string;
}

export const DEFAULT_SETTINGS: LlmAgentSettings = {
	engine: "pi",
	piPath: "pi",
	workingDir: "",
	provider: "",
	model: "",
	thinking: "medium",
	persistSession: true,
	showThinking: false,
	dialogPolicy: "ask",
	claudePath: "claude",
	claudePermissionMode: "bypassPermissions",
	claudeModel: "default",
	claudeAgentsMode: "append",
	gitSuggestCommitMessage: true,
	selectedPersona: "",
	chatSaveFolder: "Chats",
	autoRunEnabled: false,
	autoRunFolder: "99-raw",
	autoRunPrompt:
		"New source file(s) were added to the raw folder:\n{{files}}\n\nIngest them following the workflow in AGENTS.md.",
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export class LlmAgentSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: LlmAgentPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "LLM Agent" });
		containerEl.createEl("p", {
			text:
				"The agent runs as a background process scoped to your vault. It reads the vault's AGENTS.md and can read, create, and edit your wiki pages. Restart the chat panel (or reopen it) after changing these settings.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Engine")
			.setDesc("Which agent to run in the panel. Reopen or reconnect the panel after changing.")
			.addDropdown((d) => {
				d.addOption("pi", "pi");
				d.addOption("claude", "Claude Code");
				d.setValue(this.plugin.settings.engine).onChange(async (v) => {
					this.plugin.settings.engine = v as LlmAgentSettings["engine"];
					await this.plugin.saveSettings();
				});
			});

		containerEl.createEl("h3", { text: "pi" });

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
					this.plugin.settings.dialogPolicy = v as LlmAgentSettings["dialogPolicy"];
					await this.plugin.saveSettings();
				});
			});

		// ----- Claude Code engine -----
		containerEl.createEl("h3", { text: "Claude Code" });
		containerEl.createEl("p", {
			text:
				"Used when the engine is set to Claude Code. Claude reads your vault's AGENTS.md (see AGENTS.md handling below) and operates on files in the working directory.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Claude command")
			.setDesc("Command or absolute path to the Claude Code CLI (e.g. claude, or C:\\Users\\you\\.local\\bin\\claude.exe).")
			.addText((t) =>
				t
					.setPlaceholder("claude")
					.setValue(this.plugin.settings.claudePath)
					.onChange(async (v) => {
						this.plugin.settings.claudePath = v.trim() || "claude";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Claude model")
			.setDesc("Model alias or id. 'default' uses Claude Code's configured default.")
			.addDropdown((d) => {
				d.addOption("default", "Claude Code default");
				d.addOption("opus", "Opus");
				d.addOption("sonnet", "Sonnet");
				d.addOption("haiku", "Haiku");
				d.setValue(this.plugin.settings.claudeModel || "default").onChange(async (v) => {
					this.plugin.settings.claudeModel = v;
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("AGENTS.md handling")
			.setDesc(
				"Append (recommended): add your AGENTS.md to Claude Code's default prompt, keeping its built-in working-directory grounding so it stays in the vault. Replace: use AGENTS.md as the entire system prompt (can make Claude guess wrong absolute paths)."
			)
			.addDropdown((d) => {
				d.addOption("append", "Append (recommended)");
				d.addOption("replace", "Replace");
				d.setValue(this.plugin.settings.claudeAgentsMode).onChange(async (v) => {
					this.plugin.settings.claudeAgentsMode = v as LlmAgentSettings["claudeAgentsMode"];
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName("Permissions")
			.setDesc(
				"How Claude Code handles file/command permissions. Bypass all: edits, creates and runs bash (incl. git) without prompts — needed for the full AGENTS.md wiki workflow. Auto-accept edits: file edits only, bash restricted. Ask per tool: prompts you in the panel for each tool."
			)
			.addDropdown((d) => {
				d.addOption("bypassPermissions", "Bypass all (autonomous)");
				d.addOption("acceptEdits", "Auto-accept edits only");
				d.addOption("default", "Ask me per tool");
				d.setValue(this.plugin.settings.claudePermissionMode).onChange(async (v) => {
					this.plugin.settings.claudePermissionMode = v as LlmAgentSettings["claudePermissionMode"];
					await this.plugin.saveSettings();
				});
			});

		// ----- chats -----
		containerEl.createEl("h3", { text: "Chats" });

		new Setting(containerEl)
			.setName("Chat save folder")
			.setDesc("Vault-relative folder where the Save chat button writes Markdown files. Empty = vault root.")
			.addText((t) =>
				t
					.setPlaceholder("Chats")
					.setValue(this.plugin.settings.chatSaveFolder)
					.onChange(async (v) => {
						this.plugin.settings.chatSaveFolder = v.trim().replace(/^[\\/]+|[\\/]+$/g, "");
						await this.plugin.saveSettings();
					})
			);

		// ----- git -----
		containerEl.createEl("h3", { text: "Git" });

		new Setting(containerEl)
			.setName("Suggest commit messages")
			.setDesc(
				"When committing from the panel, pre-fill the dialog with a message generated by the selected engine from the staged diff (following AGENTS.md). Turn off to get an empty commit dialog."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.gitSuggestCommitMessage).onChange(async (v) => {
					this.plugin.settings.gitSuggestCommitMessage = v;
					await this.plugin.saveSettings();
				})
			);

		// ----- automation -----
		containerEl.createEl("h3", { text: "Automation" });
		containerEl.createEl("p", {
			text:
				"Automatically run a prompt when new files are added to a watched folder (e.g. dropping a source document into the raw folder).",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Run on new file in folder")
			.setDesc("When enabled, adding files to the watch folder opens the panel and runs the prompt below.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoRunEnabled).onChange(async (v) => {
					this.plugin.settings.autoRunEnabled = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Watch folder")
			.setDesc("Vault-relative folder to watch for new files.")
			.addText((t) =>
				t
					.setPlaceholder("99-raw")
					.setValue(this.plugin.settings.autoRunFolder)
					.onChange(async (v) => {
						this.plugin.settings.autoRunFolder = v.trim().replace(/^[\\/]+|[\\/]+$/g, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Prompt")
			.setDesc("Prompt sent to the agent. Use {{files}} for the list of new files and {{count}} for how many.")
			.then((s) => {
				const ta = s.controlEl.createEl("textarea", {
					cls: "llm-prompt-text",
					attr: { rows: "4" },
				});
				ta.value = this.plugin.settings.autoRunPrompt;
				ta.addEventListener("change", async () => {
					this.plugin.settings.autoRunPrompt = ta.value;
					await this.plugin.saveSettings();
				});
			});

		// ----- personas / prompts -----
		containerEl.createEl("h3", { text: "Personas & prompts" });
		containerEl.createEl("p", {
			text:
				"One-click prompts come from frontmatter. In a persona file (vault-root markdown with " +
				"PERSONA: true) add a `prompts:` list for that persona; in Default (AGENTS.md) mode the " +
				"buttons come from AGENTS.md's own `prompts:` frontmatter. Each entry is a string " +
				"\"Label | Prompt text\" — plain strings stay editable in Obsidian's Properties view.",
			cls: "setting-item-description",
		});
	}
}
