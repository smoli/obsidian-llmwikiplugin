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

		// The persona / AGENTS.md prompt file already has the fixed instructions
		// (path:line linking, schema protocol) baked in — Claude only honors a
		// single append file, so we never pass a second one.
		const personaFile = this.plugin.resolvePersonaPromptFile(personaPath);
		this.structuredResponse = this.plugin.getPersonaByPath(personaPath)?.responseSchema === true;
		const resumeSessionId = this.session.engineSessionId;

		if (engine === "claude") {
			this.backend = new ClaudeBackend({
				claudePath: s.claudePath,
				cwd,
				model: s.claudeModel || "default",
				permissionMode: s.claudePermissionMode,
				agentsFile:
					personaFile ??
					this.plugin.resolveAgentsPromptFile(!!personaPath) ??
					this.plugin.resolveFixedInstructionFile() ??
					undefined,
				agentsMode: s.claudeAgentsMode,
				resumeSessionId,
			});
		} else if (engine === "openai") {
			// OpenAI direct backend. The persona/AGENTS.md prompt becomes the system
			// `instructions`; subscription mode (no server-side state) is seeded with
			// the prior turns so the conversation continues across restarts.
			const systemPromptFile = personaFile ?? this.plugin.resolveAgentsPromptFile(false) ?? undefined;
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
				systemPromptFile,
				resumeSessionId,
				history: this.session.transcript.map((m) => ({ role: m.role, text: m.text })),
			});
		} else {
			// Disable pi's raw AGENTS.md auto-load and re-inject the frontmatter-stripped
			// version (plus the persona, if any) so pi never sees the prompts frontmatter.
			this.backend = new PiBackend({
				piPath: s.piPath,
				cwd,
				provider: s.provider || undefined,
				model: s.model || undefined,
				thinking: s.thinking,
				persistSession: s.persistSession,
				disableContextFiles: true,
				appendSystemPromptFiles: [this.plugin.resolveAgentsPromptFile(!!personaPath), personaFile].filter(
					(f): f is string => !!f
				),
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
		switch (ev.type) {
			case "run-start":
				this.streaming = true;
				this.buf = "";
				break;
			case "text-start":
				this.buf = "";
				break;
			case "text-delta":
				this.buf += ev.delta;
				break;
			case "text-end":
				if (typeof ev.content === "string") this.buf = ev.content;
				this.finalizeAssistant();
				break;
			case "run-end":
				this.streaming = false;
				this.finalizeAssistant();
				void this.captureSessionId();
				if (!this.attached) {
					this.session.unseen = true;
					this.plugin.sessionStore.upsert(this.session);
				}
				this.plugin.refreshSessionLists();
				break;
			case "error":
				this.streaming = false;
				break;
		}
		this.viewHandlers?.onEvent(ev);
	}

	private finalizeAssistant(): void {
		const text = this.buf;
		this.buf = "";
		if (!text.trim()) return;
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
