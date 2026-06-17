import { AgentBackend, BackendEvent, PermissionRequest } from "./backend";
import { PiBackend } from "./pi-backend";
import { ClaudeBackend } from "./claude-backend";
import { OpenAiBackend } from "./openai-backend";
import { ExtensionUIRequest } from "./rpc-types";
import { SavedSession } from "./sessions";
import { parseResponseEnvelopes, envelopesToTranscript } from "./response-format";
import type LlmAgentPlugin from "./main";

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * One entry in a session's debug event log — a faithful, chronological record of
 * everything the engine did (prompts, thinking, tool calls *with full payloads*,
 * per-run token stats). Used by the "Export debug log" feature to see exactly what
 * the model is doing and where tokens go. Kept in memory on the live runtime.
 */
export type DebugLogEntry =
	| { kind: "run-start"; t: number }
	| { kind: "run-end"; t: number }
	| { kind: "user"; t: number; text: string }
	| { kind: "assistant"; t: number; text: string }
	| { kind: "thinking"; t: number; text: string }
	| { kind: "tool"; t: number; id: string; name: string; args: unknown; result?: string; isError?: boolean }
	| { kind: "stats"; t: number; tokensTotal?: number; cost?: number };

/** Callbacks the rendering view registers while it is attached to a runtime. */
export interface RuntimeHandlers {
	onEvent(ev: BackendEvent): void;
	onDialog(req: ExtensionUIRequest): void;
	onPermission(req: PermissionRequest): void;
	onError(engineName: string, err: Error): void;
	onExit(engineName: string, code: number | null, lastStderr: string): void;
}

/**
 * Owns one engine backend for a single session. It processes the backend's event
 * stream **headlessly** — building the session transcript and tracking status —
 * so a session keeps accumulating its reply even when no view is rendering it.
 * A view `attach()`es to receive forwarded events for live rendering and
 * `detach()`es (leaving the runtime warm) when the user switches away.
 */
export class SessionRuntime {
	backend: AgentBackend | null = null;
	/** Whether the active persona requested a structured response envelope. */
	structuredResponse = false;
	/** A response is currently streaming. */
	streaming = false;
	/** Last time a view attached or a prompt was sent — drives LRU eviction. */
	lastUsed = 0;

	/** Assistant text accumulated for the current streamed segment (model side). */
	private buf = "";
	private viewHandlers: RuntimeHandlers | null = null;

	/** In-memory debug log (tool calls with payloads, stats, …) for export. */
	readonly debugLog: DebugLogEntry[] = [];
	/** Thinking deltas accumulated for the current run, flushed before assistant text. */
	private thinkBuf = "";
	/** tool-call id → its log entry, so tool-end can fill in the result. */
	private toolEntries = new Map<string, Extract<DebugLogEntry, { kind: "tool" }>>();

	constructor(readonly session: SavedSession, private plugin: LlmAgentPlugin) {
		this.lastUsed = Date.now();
	}

	get running(): boolean {
		return !!this.backend?.running;
	}
	get attached(): boolean {
		return this.viewHandlers !== null;
	}
	/** Partial assistant text streamed so far (for a view attaching mid-stream). */
	get currentBuf(): string {
		return this.buf;
	}

	attach(handlers: RuntimeHandlers): void {
		this.viewHandlers = handlers;
		this.lastUsed = Date.now();
		this.markSeen();
	}
	detach(): void {
		this.viewHandlers = null;
	}
	/** Clear the persisted "unseen reply" flag once the session is being viewed. */
	markSeen(): void {
		if (this.session.unseen) {
			this.session.unseen = false;
			this.plugin.sessionStore.upsert(this.session);
			this.plugin.refreshSessionLists();
		}
	}

	/**
	 * Build and start the backend from the session's engine/persona. Returns null
	 * on success or an error string to surface. No-op if already started.
	 */
	start(): string | null {
		if (this.backend) return null;
		const cwd = this.plugin.getWorkingDir();
		if (!cwd) return "Cannot resolve vault path — a local vault is required.";

		const s = this.plugin.settings;
		const engine = this.session.engine;
		const personaPath = this.session.persona;

		// One assembled system prompt for every engine: core AGENTS.md + persona +
		// declared skills + fixed instructions (Claude only honors a single append
		// file, so everything is combined into one).
		const systemFile = this.plugin.assembleSystemPromptFile(personaPath) ?? undefined;
		this.structuredResponse = this.plugin.getPersonaByPath(personaPath)?.responseSchema === true;
		const resumeSessionId = this.session.engineSessionId;

		if (engine === "claude") {
			this.backend = new ClaudeBackend({
				claudePath: s.claudePath,
				cwd,
				model: s.claudeModel || "default",
				permissionMode: s.claudePermissionMode,
				agentsFile: systemFile,
				agentsMode: s.claudeAgentsMode,
				resumeSessionId,
			});
		} else if (engine === "openai") {
			// OpenAI direct backend. The assembled prompt becomes the system
			// `instructions`; subscription mode (no server-side state) is seeded with
			// the prior turns so the conversation continues across restarts.
			const auth =
				s.openaiAuthMode === "subscription" && this.plugin.settings.openaiOAuth
					? {
							mode: "subscription" as const,
							accessToken: this.plugin.settings.openaiOAuth.access,
							accountId: this.plugin.settings.openaiOAuth.accountId,
							refresh: () => this.plugin.refreshOpenAiToken(),
					  }
					: { mode: "apikey" as const, apiKey: s.openaiApiKey, baseUrl: s.openaiBaseUrl };
			this.backend = new OpenAiBackend({
				auth,
				model: s.openaiModel,
				cwd,
				systemPromptFile: systemFile,
				resumeSessionId,
				history: this.session.transcript.map((m) => ({ role: m.role, text: m.text })),
			});
		} else {
			// Disable pi's raw AGENTS.md auto-load and inject the single assembled
			// system prompt instead (so pi never sees the prompts frontmatter).
			this.backend = new PiBackend({
				piPath: s.piPath,
				cwd,
				provider: s.provider || undefined,
				model: s.model || undefined,
				thinking: s.thinking,
				persistSession: s.persistSession,
				disableContextFiles: true,
				appendSystemPromptFiles: systemFile ? [systemFile] : [],
				resumeSessionId,
			});
		}

		const backend = this.backend;
		backend.on("event", (ev: BackendEvent) => this.onBackendEvent(ev));
		backend.on("dialog", (req: ExtensionUIRequest) => {
			if (this.viewHandlers) this.viewHandlers.onDialog(req);
			else backend.respondDialog({ id: req.id, cancelled: true });
		});
		backend.on("permission", (req: PermissionRequest) => {
			if (this.viewHandlers) this.viewHandlers.onPermission(req);
			else backend.respondPermission(req.id, { allow: false });
		});
		backend.on("error", (err: Error) => this.viewHandlers?.onError(backend.engineName, err));
		backend.on("exit", (code: number | null) => {
			this.streaming = false;
			this.viewHandlers?.onExit(backend.engineName, code, backend.lastStderr ?? "");
		});

		try {
			backend.start();
		} catch (err) {
			return `Failed to start ${engine}: ${errorMessage(err)}`;
		}
		return null;
	}

	/** Send a prompt; records the user turn in the transcript first (unless steering). */
	async prompt(text: string, steering: boolean): Promise<{ ok: boolean; error?: string }> {
		if (!this.backend?.running) return { ok: false, error: "The agent is not running." };
		this.lastUsed = Date.now();
		this.session.transcript.push({ role: "user", text });
		this.debugLog.push({ kind: "user", t: Date.now(), text });
		this.afterTranscriptChange();
		return this.backend.prompt(text, steering);
	}

	dispose(): void {
		this.backend?.dispose();
		this.backend = null;
		this.viewHandlers = null;
	}

	// ----------------------------------------------------- headless processing

	private onBackendEvent(ev: BackendEvent): void {
		const t = Date.now();
		switch (ev.type) {
			case "run-start":
				this.streaming = true;
				this.buf = "";
				this.debugLog.push({ kind: "run-start", t });
				break;
			case "text-start":
				this.buf = "";
				break;
			case "text-delta":
				this.buf += ev.delta;
				break;
			case "text-end":
				if (typeof ev.content === "string") this.buf = ev.content;
				this.flushThinking(t);
				this.finalizeAssistant();
				break;
			case "thinking-delta":
				this.thinkBuf += ev.delta;
				break;
			case "tool-start": {
				const entry: Extract<DebugLogEntry, { kind: "tool" }> = {
					kind: "tool",
					t,
					id: ev.id,
					name: ev.name,
					args: ev.args,
				};
				this.toolEntries.set(ev.id, entry);
				this.debugLog.push(entry);
				break;
			}
			case "tool-update": {
				const entry = this.toolEntries.get(ev.id);
				if (entry) entry.result = (entry.result ?? "") + ev.text;
				break;
			}
			case "tool-end": {
				const entry = this.toolEntries.get(ev.id);
				if (entry) {
					entry.result = ev.text;
					entry.isError = ev.isError;
				} else {
					this.debugLog.push({ kind: "tool", t, id: ev.id, name: "(unknown)", args: undefined, result: ev.text, isError: ev.isError });
				}
				break;
			}
			case "stats":
				this.debugLog.push({ kind: "stats", t, tokensTotal: ev.stats.tokensTotal, cost: ev.stats.cost });
				break;
			case "run-end":
				this.streaming = false;
				this.flushThinking(t);
				this.finalizeAssistant();
				this.debugLog.push({ kind: "run-end", t });
				void this.captureSessionId();
				if (!this.attached) {
					this.session.unseen = true;
					this.plugin.sessionStore.upsert(this.session);
				}
				this.plugin.refreshSessionLists();
				break;
			case "error":
				this.streaming = false;
				this.debugLog.push({ kind: "assistant", t, text: `[error] ${ev.message}` });
				break;
		}
		this.viewHandlers?.onEvent(ev);
	}

	/** Emit any buffered thinking as a log entry (before assistant text / at run end). */
	private flushThinking(t: number): void {
		if (this.thinkBuf.trim()) this.debugLog.push({ kind: "thinking", t, text: this.thinkBuf });
		this.thinkBuf = "";
	}

	private finalizeAssistant(): void {
		const text = this.buf;
		this.buf = "";
		if (!text.trim()) return;
		this.debugLog.push({ kind: "assistant", t: Date.now(), text });
		const envs = this.structuredResponse ? parseResponseEnvelopes(text) : [];
		if (envs.length) {
			// Keep the envelopes so chips/checkboxes re-render on session restore.
			this.session.transcript.push({ role: "assistant", text: envelopesToTranscript(envs), envelopes: envs });
		} else {
			this.session.transcript.push({ role: "assistant", text });
		}
		this.afterTranscriptChange();
	}

	private async captureSessionId(): Promise<void> {
		const sid = await this.backend?.getEngineSessionId();
		if (sid && sid !== this.session.engineSessionId) {
			this.session.engineSessionId = sid;
			if (this.session.transcript.length) this.plugin.sessionStore.upsert(this.session);
		}
	}

	/** Name the session lazily, bump its timestamp, persist, refresh sidebars. */
	private afterTranscriptChange(): void {
		if (this.session.transcript.length === 0) return;
		if (!this.session.name) {
			const first = this.session.transcript.find((t) => t.role === "user")?.text ?? "New chat";
			this.session.name = first.split("\n").map((l) => l.trim()).filter(Boolean)[0]?.slice(0, 60) || "New chat";
		}
		this.session.updatedAt = Date.now();
		this.plugin.sessionStore.upsert(this.session);
		this.plugin.refreshSessionLists();
	}
}

/** Holds the live runtimes keyed by session id. */
export class SessionManager {
	private runtimes = new Map<string, SessionRuntime>();

	constructor(private plugin: LlmAgentPlugin) {}

	/** Existing runtime for the session, or a fresh one. */
	acquire(session: SavedSession): SessionRuntime {
		let runtime = this.runtimes.get(session.id);
		if (!runtime) {
			runtime = new SessionRuntime(session, this.plugin);
			this.runtimes.set(session.id, runtime);
		}
		return runtime;
	}

	get(id: string): SessionRuntime | undefined {
		return this.runtimes.get(id);
	}

	/**
	 * Enforce the warm-runtime cap: keep the active (attached) and any streaming
	 * runtimes, and shut down the least-recently-used idle background ones beyond
	 * the limit. Their transcript is persisted, so they resume on demand. Call
	 * after starting a runtime.
	 */
	enforceCap(): void {
		const cap = Math.max(1, this.plugin.settings.maxWarmSessions || 4);
		const warm = [...this.runtimes.values()].filter((r) => r.backend);
		let over = warm.length - cap;
		if (over <= 0) return;
		const evictable = warm
			.filter((r) => !r.attached && !r.streaming)
			.sort((a, b) => a.lastUsed - b.lastUsed);
		let evicted = 0;
		for (const r of evictable) {
			if (over <= 0) break;
			r.dispose();
			this.runtimes.delete(r.session.id);
			over--;
			evicted++;
		}
		if (evicted) this.plugin.refreshSessionLists();
	}

	/** Dispose and forget a runtime. */
	release(id: string): void {
		const runtime = this.runtimes.get(id);
		if (runtime) {
			runtime.dispose();
			this.runtimes.delete(id);
		}
	}

	disposeAll(): void {
		for (const runtime of this.runtimes.values()) runtime.dispose();
		this.runtimes.clear();
	}
}
