import { App, PluginSettingTab, Setting } from "obsidian";
import type LlmAgentPlugin from "./main";
import { ThinkingLevel } from "./rpc-types";

export interface LlmAgentSettings {
	/** Which agent engine to drive: pi, the Claude Code CLI, or the OpenAI API. */
	engine: "pi" | "claude" | "openai";
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
	/** Show tool-call blocks in the chat. When off, the busy indicator names the
	 *  current tool instead (e.g. "calling bash"). */
	showToolCalls: boolean;
	/** Auto-attach the current editor selection to open chat panels as a context chip. */
	autoAttachSelection: boolean;
	/** Max number of warm session runtimes (live engine processes) to keep. */
	maxWarmSessions: number;
	/**
	 * How to handle tool-permission / confirmation dialogs raised by pi
	 * extensions: ask the user, always allow, or always block.
	 */
	dialogPolicy: "ask" | "allow" | "block";
	/** Whether the in-panel session sidebar is collapsed. */
	sidebarCollapsed: boolean;

	// --- Automation: run a prompt when files land in a watched folder ---
	/** Enable auto-running a prompt when new files appear in the watch folder. */
	autoRunEnabled: boolean;
	/** Vault-relative folder to watch for new files (e.g. "99-raw"). */
	autoRunFolder: string;
	/** Prompt to run; supports {{files}} (newline list) and {{count}} placeholders. */
	autoRunPrompt: string;
	/** Persona (vault-relative path, "" = AGENTS.md) for the automation's session. */
	autoRunPersona: string;

	// --- Claude Code engine ---
	/** Command or absolute path used to launch the Claude Code CLI. */
	claudePath: string;
	/** Permission handling for Claude Code's tools in the vault. */
	claudePermissionMode: "bypassPermissions" | "acceptEdits" | "default";
	/** Model for Claude Code: "default" | "opus" | "sonnet" | "haiku" | explicit id. */
	claudeModel: string;
	/** Whether AGENTS.md appends to or replaces Claude Code's system prompt. */
	claudeAgentsMode: "append" | "replace";

	// --- OpenAI engine (direct API) ---
	/** How to authenticate to OpenAI: an API key, or a ChatGPT subscription login. */
	openaiAuthMode: "apikey" | "subscription";
	/** OpenAI API key (sent as a Bearer token). Stored in data.json (plaintext). */
	openaiApiKey: string;
	/** API base URL; override for Azure / OpenAI-compatible endpoints. */
	openaiBaseUrl: string;
	/** Model id, e.g. "gpt-5". */
	openaiModel: string;
	/** ChatGPT (Codex) OAuth credentials when using subscription auth. */
	openaiOAuth: { access: string; refresh: string; expires: number; accountId: string } | null;

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
	showToolCalls: true,
	autoAttachSelection: false,
	maxWarmSessions: 4,
	dialogPolicy: "ask",
	sidebarCollapsed: false,
	claudePath: "claude",
	claudePermissionMode: "bypassPermissions",
	claudeModel: "default",
	claudeAgentsMode: "append",
	openaiAuthMode: "apikey",
	openaiApiKey: "",
	openaiBaseUrl: "https://api.openai.com/v1",
	openaiModel: "gpt-5",
	openaiOAuth: null,
	gitSuggestCommitMessage: true,
	selectedPersona: "",
	chatSaveFolder: "Chats",
	autoRunEnabled: false,
	autoRunFolder: "99-raw",
	autoRunPrompt:
		"New source file(s) were added to the raw folder:\n{{files}}\n\nIngest them following the workflow in AGENTS.md.",
	autoRunPersona: "",
};

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export class LlmAgentSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: LlmAgentPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "STS-LLM Wiki" });
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
				d.addOption("openai", "OpenAI");
				d.setValue(this.plugin.settings.engine).onChange(async (v) => {
					this.plugin.settings.engine = v as LlmAgentSettings["engine"];
					await this.plugin.saveSettings();
				});
			});

		// ----- general chat-panel display (both engines) -----
		containerEl.createEl("h3", { text: "Chat panel" });

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
			.setName("Show tool calls")
			.setDesc(
				"Display each tool call (bash, read, edit, …) as a block in the chat. When off, the chat stays clean and the working indicator names the current tool instead (e.g. \"calling bash\")."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.showToolCalls).onChange(async (v) => {
					this.plugin.settings.showToolCalls = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Auto-attach selection")
			.setDesc(
				"Experimental: when you select text in a note, attach it to the open chat panel automatically (as a context chip), without using the right-click menu."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoAttachSelection).onChange(async (v) => {
					this.plugin.settings.autoAttachSelection = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Max background sessions")
			.setDesc(
				"How many session engine processes to keep running at once. The active session and any still streaming are always kept; extra idle background sessions beyond this limit are shut down (least-recently-used first) and resume on demand when reopened."
			)
			.addText((t) =>
				t
					.setPlaceholder("4")
					.setValue(String(this.plugin.settings.maxWarmSessions))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						this.plugin.settings.maxWarmSessions = Number.isFinite(n) && n >= 1 ? n : 4;
						await this.plugin.saveSettings();
					})
			);

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

		// ----- OpenAI engine -----
		containerEl.createEl("h3", { text: "OpenAI" });
		containerEl.createEl("p", {
			text:
				"Used when the engine is set to OpenAI: the plugin talks to OpenAI directly, confined to the working directory. Credentials are stored in this plugin's data.json (plaintext) — keep that in mind.",
			cls: "setting-item-description",
		});

		new Setting(containerEl)
			.setName("Authentication")
			.setDesc("API key, or sign in with a ChatGPT subscription (Plus/Pro/Team, Codex flow).")
			.addDropdown((d) => {
				d.addOption("apikey", "API key");
				d.addOption("subscription", "ChatGPT subscription login");
				d.setValue(this.plugin.settings.openaiAuthMode).onChange(async (v) => {
					this.plugin.settings.openaiAuthMode = v as LlmAgentSettings["openaiAuthMode"];
					await this.plugin.saveSettings();
					this.display();
				});
			});

		if (this.plugin.settings.openaiAuthMode === "subscription") {
			const oauth = this.plugin.settings.openaiOAuth;
			new Setting(containerEl)
				.setName("ChatGPT sign-in")
				.setDesc(
					oauth
						? `Signed in (account …${oauth.accountId.slice(-6)}). Uses the undocumented Codex backend — may change without notice.`
						: "Not signed in. A browser window opens for OpenAI login (uses the Codex flow)."
				)
				.addButton((b) =>
					b.setButtonText(oauth ? "Re-sign in" : "Sign in with ChatGPT").onClick(async () => {
						b.setDisabled(true).setButtonText("Waiting for browser…");
						const ok = await this.plugin.loginOpenAi();
						if (ok) this.display();
						else b.setDisabled(false).setButtonText("Sign in with ChatGPT");
					})
				)
				.then((s) => {
					if (oauth) {
						s.addExtraButton((b) =>
							b.setIcon("log-out").setTooltip("Sign out").onClick(async () => {
								await this.plugin.logoutOpenAi();
								this.display();
							})
						);
					}
				});
		} else {
			new Setting(containerEl)
				.setName("API key")
				.setDesc("Sent as a Bearer token. Stored locally in data.json.")
				.addText((t) => {
					t.setPlaceholder("sk-…")
						.setValue(this.plugin.settings.openaiApiKey)
						.onChange(async (v) => {
							this.plugin.settings.openaiApiKey = v.trim();
							await this.plugin.saveSettings();
						});
					t.inputEl.type = "password";
				});
		}

		new Setting(containerEl)
			.setName("Model")
			.setDesc("OpenAI model id, e.g. gpt-5.")
			.addText((t) =>
				t
					.setPlaceholder("gpt-5")
					.setValue(this.plugin.settings.openaiModel)
					.onChange(async (v) => {
						this.plugin.settings.openaiModel = v.trim() || "gpt-5";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Base URL")
			.setDesc("API base URL. Override for Azure OpenAI or OpenAI-compatible endpoints.")
			.addText((t) =>
				t
					.setPlaceholder("https://api.openai.com/v1")
					.setValue(this.plugin.settings.openaiBaseUrl)
					.onChange(async (v) => {
						this.plugin.settings.openaiBaseUrl = v.trim().replace(/\/+$/, "") || "https://api.openai.com/v1";
						await this.plugin.saveSettings();
					})
			);

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
			.setName("Persona")
			.setDesc("Persona used for the automation's session. The run always opens a fresh session with this persona.")
			.addDropdown((d) => {
				d.addOption("", "Default (AGENTS.md)");
				for (const p of this.plugin.getPersonas()) d.addOption(p.path, p.name);
				// Fall back to default if the saved persona no longer exists.
				const saved = this.plugin.settings.autoRunPersona;
				const exists = !saved || this.plugin.getPersonas().some((p) => p.path === saved);
				d.setValue(exists ? saved : "");
				d.onChange(async (v) => {
					this.plugin.settings.autoRunPersona = v;
					await this.plugin.saveSettings();
				});
			});

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
