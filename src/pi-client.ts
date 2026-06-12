import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";
import {
	ExtensionUIRequest,
	PiModel,
	RpcCommand,
	RpcResponse,
	StreamLine,
	ThinkingLevel,
	isExtensionUIRequest,
	isResponse,
} from "./rpc-types";

export interface PiClientOptions {
	/** Command used to launch pi (e.g. "pi" or an absolute path to pi.cmd). */
	piPath: string;
	/** Working directory pi runs in — the wiki/vault root that holds AGENTS.md. */
	cwd: string;
	/** Provider passed via --provider (optional). */
	provider?: string;
	/** Model pattern passed via --model (optional). */
	model?: string;
	/** Thinking level passed via --thinking (optional). */
	thinking?: ThinkingLevel;
	/** Persist sessions to disk (false adds --no-session). */
	persistSession: boolean;
	/** Extra environment variables merged over process.env. */
	env?: Record<string, string>;
}

/**
 * Spawns `pi --mode rpc` as a child process and speaks the JSONL RPC protocol
 * over stdin/stdout. Responses are correlated to commands by an auto-generated
 * id; all other lines are re-emitted as typed events.
 *
 * Events emitted:
 *   - "event"     (RpcEvent)            every streamed agent event
 *   - "ui"        (ExtensionUIRequest)  extension UI request (caller must answer dialogs)
 *   - "exit"      (code, signal)        process exited
 *   - "error"     (Error)               spawn/runtime error
 *   - "stderr"    (string)              raw stderr text (diagnostics)
 */
export class PiClient extends EventEmitter {
	private proc: ChildProcessWithoutNullStreams | null = null;
	private pending = new Map<string, (res: RpcResponse) => void>();
	private nextId = 1;
	private stdoutDecoder = new StringDecoder("utf8");
	private stdoutBuffer = "";
	private stderrBuffer = "";
	private disposed = false;

	constructor(private readonly opts: PiClientOptions) {
		super();
	}

	get running(): boolean {
		return this.proc !== null && this.proc.exitCode === null;
	}

	start(): void {
		if (this.proc) return;

		const args = ["--mode", "rpc"];
		if (!this.opts.persistSession) args.push("--no-session");
		if (this.opts.provider) args.push("--provider", this.opts.provider);
		if (this.opts.model) args.push("--model", this.opts.model);
		if (this.opts.thinking) args.push("--thinking", this.opts.thinking);

		// On Windows the `pi` binary is a `.cmd` shim, which requires a shell to
		// launch. Elsewhere we spawn directly.
		const useShell = process.platform === "win32";

		const proc = spawn(this.opts.piPath, args, {
			cwd: this.opts.cwd,
			shell: useShell,
			windowsHide: true,
			env: { ...process.env, ...(this.opts.env ?? {}) },
		});
		this.proc = proc;

		proc.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
		proc.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString("utf8");
			this.stderrBuffer += text;
			if (this.stderrBuffer.length > 8000) {
				this.stderrBuffer = this.stderrBuffer.slice(-8000);
			}
			this.emit("stderr", text);
		});
		proc.on("error", (err) => this.emit("error", err));
		proc.on("exit", (code, signal) => {
			// Reject any in-flight requests so callers don't hang.
			for (const resolve of this.pending.values()) {
				resolve({
					type: "response",
					command: "unknown",
					success: false,
					error: `pi process exited (code ${code ?? "?"}, signal ${signal ?? "?"})`,
				});
			}
			this.pending.clear();
			this.proc = null;
			if (!this.disposed) this.emit("exit", code, signal);
		});
	}

	/** Last captured stderr text — useful when the process dies on startup. */
	get lastStderr(): string {
		return this.stderrBuffer.trim();
	}

	dispose(): void {
		this.disposed = true;
		if (this.proc) {
			try {
				this.proc.stdin.end();
			} catch {
				/* ignore */
			}
			this.proc.kill();
			this.proc = null;
		}
		this.pending.clear();
		this.removeAllListeners();
	}

	// --- JSONL framing (per docs/rpc.md: split on \n only, strip trailing \r) ---

	private onStdout(chunk: Buffer): void {
		this.stdoutBuffer += this.stdoutDecoder.write(chunk);
		for (;;) {
			const nl = this.stdoutBuffer.indexOf("\n");
			if (nl === -1) break;
			let line = this.stdoutBuffer.slice(0, nl);
			this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length > 0) this.handleLine(line);
		}
	}

	private handleLine(line: string): void {
		let parsed: StreamLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Non-JSON noise on stdout — surface as stderr-ish diagnostic.
			this.emit("stderr", line + "\n");
			return;
		}

		if (isResponse(parsed)) {
			if (parsed.id && this.pending.has(parsed.id)) {
				const resolve = this.pending.get(parsed.id)!;
				this.pending.delete(parsed.id);
				resolve(parsed);
			}
			return;
		}

		if (isExtensionUIRequest(parsed)) {
			this.emit("ui", parsed as ExtensionUIRequest);
			return;
		}

		this.emit("event", parsed);
	}

	// --- Command sending ---

	private writeRaw(obj: Record<string, unknown>): void {
		if (!this.proc) throw new Error("pi process is not running");
		this.proc.stdin.write(JSON.stringify(obj) + "\n");
	}

	/** Send a command and await its correlated response. */
	send(command: RpcCommand, timeoutMs = 120_000): Promise<RpcResponse> {
		if (!this.proc) return Promise.reject(new Error("pi process is not running"));
		const id = command.id ?? `c${this.nextId++}`;
		const payload = { ...command, id };
		return new Promise<RpcResponse>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					reject(new Error(`pi command "${command.type}" timed out`));
				}
			}, timeoutMs);
			this.pending.set(id, (res) => {
				clearTimeout(timer);
				resolve(res);
			});
			try {
				this.writeRaw(payload);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(err);
			}
		});
	}

	/** Answer an extension UI dialog request (fire-and-forget). */
	respondUI(response: Record<string, unknown>): void {
		this.writeRaw({ type: "extension_ui_response", ...response });
	}

	// --- Convenience wrappers ---

	async prompt(message: string, streamingBehavior?: "steer" | "followUp"): Promise<RpcResponse> {
		const cmd: RpcCommand = { type: "prompt", message };
		if (streamingBehavior) cmd.streamingBehavior = streamingBehavior;
		return this.send(cmd);
	}

	abort(): Promise<RpcResponse> {
		return this.send({ type: "abort" });
	}

	newSession(): Promise<RpcResponse> {
		return this.send({ type: "new_session" });
	}

	getState(): Promise<RpcResponse> {
		return this.send({ type: "get_state" });
	}

	getSessionStats(): Promise<RpcResponse> {
		return this.send({ type: "get_session_stats" });
	}

	async getAvailableModels(): Promise<PiModel[]> {
		const res = await this.send({ type: "get_available_models" });
		if (!res.success) return [];
		return (res.data?.models ?? []) as PiModel[];
	}

	setModel(provider: string, modelId: string): Promise<RpcResponse> {
		return this.send({ type: "set_model", provider, modelId });
	}

	setThinkingLevel(level: ThinkingLevel): Promise<RpcResponse> {
		return this.send({ type: "set_thinking_level", level });
	}
}
