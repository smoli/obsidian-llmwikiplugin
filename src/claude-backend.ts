import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import {
	AgentBackend,
	BackendCapabilities,
	BackendModel,
	BaseBackend,
	NormalizedStats,
	PromptResult,
} from "./backend";
import { attachJsonlReader } from "./jsonl";
import { ThinkingLevel } from "./rpc-types";

export interface ClaudeBackendOptions {
	claudePath: string;
	cwd: string;
	/** "default" | "opus" | "sonnet" | "haiku" | explicit id */
	model?: string;
	/** acceptEdits | bypassPermissions | default | plan */
	permissionMode: string;
	/** Absolute path to AGENTS.md. */
	agentsFile?: string;
	/** Append AGENTS.md to Claude's default prompt, or replace it entirely. */
	agentsMode: "append" | "replace";
	/** Existing session_id to resume on startup (for switching sessions). */
	resumeSessionId?: string;
	env?: Record<string, string>;
}

const CLAUDE_MODELS: BackendModel[] = [
	{ key: "default", label: "Claude Code default" },
	{ key: "opus", label: "Opus" },
	{ key: "sonnet", label: "Sonnet" },
	{ key: "haiku", label: "Haiku" },
];

/**
 * Drives the Claude Code CLI in streaming-JSON headless mode
 * (`claude --print --input-format stream-json --output-format stream-json
 * --include-partial-messages`) and translates its events into the engine-neutral
 * BackendEvent shape.
 */
export class ClaudeBackend extends BaseBackend implements AgentBackend {
	readonly engineName = "claude";
	readonly capabilities: BackendCapabilities = { thinking: false, liveModels: false };

	private proc: ChildProcessWithoutNullStreams | null = null;
	private stderrBuffer = "";
	private disposed = false;

	private sessionId: string | undefined;
	private model: string;
	private lastStats: NormalizedStats | null = null;

	/** Per-message flag: did we already stream text deltas for the open assistant message? */
	private streamedText = false;
	/** Pending permission requests, keyed by request id, holding the original tool input. */
	private pendingPermissions = new Map<string, unknown>();
	private controlSeq = 0;

	constructor(private opts: ClaudeBackendOptions) {
		super();
		this.model = opts.model ?? "default";
		this.sessionId = opts.resumeSessionId;
	}

	async getEngineSessionId(): Promise<string | undefined> {
		return this.sessionId;
	}

	get running(): boolean {
		return this.proc !== null && this.proc.exitCode === null;
	}
	get lastStderr(): string {
		return this.stderrBuffer.trim();
	}

	start(): void {
		// Resume an existing session when one was provided (session switching).
		this.spawnProcess(!!this.sessionId);
	}

	dispose(): void {
		this.disposed = true;
		this.killProc();
		this.removeAllListeners();
	}

	// ----------------------------------------------------------- process mgmt

	private spawnProcess(resume: boolean): void {
		const o = this.opts;
		const args = [
			"--print",
			"--input-format",
			"stream-json",
			"--output-format",
			"stream-json",
			"--include-partial-messages",
			"--verbose",
			"--permission-mode",
			o.permissionMode,
		];
		if (this.model && this.model !== "default") args.push("--model", this.model);
		if (o.agentsFile && o.agentsMode === "replace") {
			// Replacing Claude Code's prompt removes its environment grounding (the
			// real cwd), so re-add it — otherwise Claude invents an absolute base path.
			args.push("--system-prompt-file", o.agentsFile);
			args.push("--append-system-prompt", this.workspaceGrounding(o.cwd));
		} else if (o.agentsFile) {
			// Append: keep Claude Code's default prompt (with its own cwd grounding)
			// and add the wiki rules on top.
			args.push("--append-system-prompt-file", o.agentsFile);
		}
		if (resume && this.sessionId) args.push("--resume", this.sessionId);

		// .exe can be spawned directly; a bare command / .cmd shim needs a shell on Windows.
		const useShell = process.platform === "win32" && !/\.exe$/i.test(o.claudePath);

		const proc = spawn(o.claudePath, args, {
			cwd: o.cwd,
			shell: useShell,
			windowsHide: true,
			env: { ...process.env, ...(o.env ?? {}) },
		});
		this.proc = proc;

		attachJsonlReader(proc.stdout, (line) => this.handleLine(line));
		proc.stderr.on("data", (chunk: Buffer) => {
			this.stderrBuffer += chunk.toString("utf8");
			if (this.stderrBuffer.length > 8000) this.stderrBuffer = this.stderrBuffer.slice(-8000);
		});
		proc.on("error", (err) => this.emit("error", err));
		proc.on("exit", (code, signal) => {
			// Only react if this is still the active process. During a restart the
			// old process exits after a new one has replaced it — ignore that.
			if (this.proc === proc) this.proc = null;
			if (this.proc !== null) return;
			if (this.disposed) return;
			this.emit("exit", code ?? (signal ? 1 : 0));
		});
	}

	/** One-line grounding so Claude knows the real vault root and stays inside it. */
	private workspaceGrounding(cwd: string): string {
		return (
			`Your working directory is ${cwd}. It is the root of this Obsidian vault / wiki, and every file you read, create, or edit lives inside it. ` +
			`Always address files with paths relative to this directory, using forward slashes and NO leading slash — for example "05-wiki/01-index.md", never "/05-wiki/01-index.md". ` +
			`A leading "/" or "\\" is treated as an absolute filesystem path and will fail; never use leading slashes, backslashes, drive letters, or absolute paths. ` +
			`Never read or write files outside this directory.`
		);
	}

	private killProc(): void {
		if (this.proc) {
			try {
				this.proc.stdin.end();
			} catch {
				/* ignore */
			}
			this.proc.kill();
			this.proc = null;
		}
	}

	private restart(resume: boolean): void {
		this.killProc();
		this.streamedText = false;
		this.pendingPermissions.clear();
		this.spawnProcess(resume);
	}

	private writeStdin(obj: Record<string, unknown>): void {
		if (!this.proc) return;
		this.proc.stdin.write(JSON.stringify(obj) + "\n");
	}

	// ----------------------------------------------------------------- prompt

	async prompt(text: string, _steering = false): Promise<PromptResult> {
		if (!this.running) return { ok: false, error: "Claude process is not running" };
		this.streamedText = false;
		this.emitEvent({ type: "run-start" });
		this.writeStdin({
			type: "user",
			message: { role: "user", content: text },
		});
		return { ok: true };
	}

	abort(): void {
		if (!this.running) return;
		this.writeStdin({
			type: "control_request",
			request_id: this.nextControlId(),
			request: { subtype: "interrupt" },
		});
	}

	async newSession(): Promise<void> {
		this.sessionId = undefined;
		this.lastStats = null;
		this.restart(false);
	}

	// ------------------------------------------------------------------ model

	async getModels(): Promise<BackendModel[]> {
		return CLAUDE_MODELS;
	}
	async getActiveModelKey(): Promise<string | undefined> {
		return this.model;
	}
	async setModel(key: string): Promise<PromptResult> {
		this.model = key || "default";
		// Restart, resuming the current session so context is preserved.
		this.restart(true);
		return { ok: true };
	}

	async setThinking(_level: ThinkingLevel): Promise<void> {
		/* Claude Code has no equivalent live thinking control. */
	}

	async getStats(): Promise<NormalizedStats | null> {
		return this.lastStats;
	}

	// ------------------------------------------------------------- permissions

	respondPermission(id: string, decision: { allow: boolean }, input?: unknown): void {
		const original = this.pendingPermissions.get(id);
		this.pendingPermissions.delete(id);
		const response = decision.allow
			? { behavior: "allow", updatedInput: input ?? original ?? {} }
			: { behavior: "deny", message: "Denied by user" };
		this.writeStdin({
			type: "control_response",
			response: { subtype: "success", request_id: id, response },
		});
	}

	// ------------------------------------------------- stream-json translation

	private handleLine(line: string): void {
		let o: any;
		try {
			o = JSON.parse(line);
		} catch {
			return;
		}

		switch (o.type) {
			case "system":
				if (o.subtype === "init" && o.session_id) this.sessionId = o.session_id;
				break;

			case "stream_event":
				this.handleStreamEvent(o.event);
				break;

			case "assistant":
				this.handleAssistantMessage(o.message);
				break;

			case "user":
				this.handleUserMessage(o.message);
				break;

			case "result":
				this.handleResult(o);
				break;

			case "control_request":
				this.handleControlRequest(o);
				break;
		}
	}

	private handleStreamEvent(event: any): void {
		if (!event) return;
		switch (event.type) {
			case "message_start":
				this.streamedText = false;
				break;
			case "content_block_start":
				if (event.content_block?.type === "text") {
					this.emitEvent({ type: "text-start" });
				}
				break;
			case "content_block_delta": {
				const d = event.delta;
				if (!d) break;
				if (d.type === "text_delta") {
					this.streamedText = true;
					this.emitEvent({ type: "text-delta", delta: d.text ?? "" });
				} else if (d.type === "thinking_delta") {
					this.emitEvent({ type: "thinking-delta", delta: d.thinking ?? "" });
				}
				break;
			}
		}
	}

	private handleAssistantMessage(message: any): void {
		const content = Array.isArray(message?.content) ? message.content : [];

		// Finalize / emit the assistant text.
		const textBlock = content.find((b: any) => b?.type === "text");
		if (this.streamedText) {
			this.emitEvent({ type: "text-end" });
		} else if (textBlock && typeof textBlock.text === "string" && textBlock.text.length > 0) {
			this.emitEvent({ type: "text-start" });
			this.emitEvent({ type: "text-delta", delta: textBlock.text });
			this.emitEvent({ type: "text-end", content: textBlock.text });
		}
		this.streamedText = false;

		// Emit tool calls with their full parsed input.
		for (const block of content) {
			if (block?.type === "tool_use") {
				this.emitEvent({
					type: "tool-start",
					id: block.id,
					name: block.name,
					args: block.input,
				});
			}
		}
	}

	private handleUserMessage(message: any): void {
		const content = Array.isArray(message?.content) ? message.content : [];
		for (const block of content) {
			if (block?.type === "tool_result") {
				this.emitEvent({
					type: "tool-end",
					id: block.tool_use_id,
					text: this.stringifyContent(block.content),
					isError: !!block.is_error,
				});
			}
		}
	}

	private handleResult(o: any): void {
		const usage = o.usage ?? {};
		const tokensTotal =
			(usage.input_tokens ?? 0) +
			(usage.output_tokens ?? 0) +
			(usage.cache_read_input_tokens ?? 0) +
			(usage.cache_creation_input_tokens ?? 0);
		this.lastStats = {
			tokensTotal: tokensTotal || undefined,
			cost: typeof o.total_cost_usd === "number" ? o.total_cost_usd : undefined,
			contextPercent: null,
		};
		this.emitEvent({ type: "stats", stats: this.lastStats });

		if (o.is_error || (o.subtype && o.subtype !== "success")) {
			const msg =
				typeof o.result === "string" && o.result
					? o.result
					: `Claude ended with: ${o.subtype ?? "error"}`;
			this.emitEvent({ type: "error", message: msg });
		}
		this.emitEvent({ type: "run-end" });
	}

	private handleControlRequest(o: any): void {
		const req = o.request;
		if (req?.subtype === "can_use_tool") {
			const id = o.request_id;
			this.pendingPermissions.set(id, req.input);
			this.emit("permission", { id, toolName: req.tool_name, input: req.input });
		}
		// Other control request subtypes are not used in our configuration.
	}

	private stringifyContent(content: any): string {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.map((c: any) => {
					if (typeof c === "string") return c;
					if (c?.type === "text" && typeof c.text === "string") return c.text;
					return "";
				})
				.filter(Boolean)
				.join("\n");
		}
		return "";
	}

	private nextControlId(): string {
		this.controlSeq += 1;
		return `ctl_${Date.now().toString(36)}_${this.controlSeq}`;
	}
}
