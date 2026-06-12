import { EventEmitter } from "events";
import { ThinkingLevel } from "./rpc-types";

/** A selectable model presented in the panel's model dropdown. */
export interface BackendModel {
	/** Opaque key the backend understands (e.g. "anthropic claude-opus-4-8" or "opus"). */
	key: string;
	/** Human label shown in the dropdown. */
	label: string;
}

/** Normalized usage/cost stats shown in the status line. */
export interface NormalizedStats {
	tokensTotal?: number;
	cost?: number;
	contextPercent?: number | null;
}

export interface PromptResult {
	ok: boolean;
	error?: string;
}

/** A permission request raised by the engine (Claude's can_use_tool). */
export interface PermissionRequest {
	id: string;
	toolName: string;
	input: unknown;
}

/**
 * Engine-neutral events the chat view renders. Both PiBackend and ClaudeBackend
 * translate their native protocols into this shape.
 */
export type BackendEvent =
	| { type: "run-start" }
	| { type: "run-end" }
	| { type: "text-start" }
	| { type: "text-delta"; delta: string }
	| { type: "text-end"; content?: string }
	| { type: "thinking-delta"; delta: string }
	| { type: "tool-start"; id: string; name: string; args: unknown }
	| { type: "tool-update"; id: string; text: string }
	| { type: "tool-end"; id: string; text: string; isError: boolean }
	| { type: "error"; message: string }
	| { type: "status"; text: string }
	| { type: "stats"; stats: NormalizedStats }
	| { type: "notice"; message: string; level?: "info" | "warning" | "error" };

export interface BackendCapabilities {
	/** Whether the engine exposes a thinking-level control. */
	thinking: boolean;
	/** Whether models can be listed/switched live (vs a fixed list / restart). */
	liveModels: boolean;
}

/**
 * Common interface for an agent engine driven as a subprocess. Emitted events:
 *   - "event"      (BackendEvent)         normalized stream events
 *   - "dialog"     (ExtensionUIRequest)   pi extension UI dialog (pi only)
 *   - "permission" (PermissionRequest)    tool-permission ask (Claude only)
 *   - "error"      (Error)
 *   - "exit"       (code: number | null)
 */
export interface AgentBackend extends EventEmitter {
	readonly engineName: string;
	readonly capabilities: BackendCapabilities;
	readonly running: boolean;
	readonly lastStderr: string;

	start(): void;
	dispose(): void;

	prompt(text: string, steering?: boolean): Promise<PromptResult>;
	abort(): void;
	newSession(): Promise<void>;

	getModels(): Promise<BackendModel[]>;
	getActiveModelKey(): Promise<string | undefined>;
	setModel(key: string): Promise<PromptResult>;

	setThinking(level: ThinkingLevel): Promise<void>;
	getStats(): Promise<NormalizedStats | null>;

	/** The engine's session identifier (claude session_id / pi session id) for resuming. */
	getEngineSessionId(): Promise<string | undefined>;

	/** Answer a pi extension UI dialog. */
	respondDialog(payload: Record<string, unknown>): void;
	/** Answer a Claude permission request. */
	respondPermission(id: string, decision: { allow: boolean }, input?: unknown): void;
}

/** Shared options used to construct either backend. */
export interface BackendOptions {
	cwd: string;
	model?: string;
	thinking?: ThinkingLevel;
	persistSession: boolean;
	/** Absolute path to the vault's AGENTS.md, if present. */
	agentsFile?: string;
}

export abstract class BaseBackend extends EventEmitter implements AgentBackend {
	abstract readonly engineName: string;
	abstract readonly capabilities: BackendCapabilities;
	abstract get running(): boolean;
	abstract get lastStderr(): string;

	abstract start(): void;
	abstract dispose(): void;
	abstract prompt(text: string, steering?: boolean): Promise<PromptResult>;
	abstract abort(): void;
	abstract newSession(): Promise<void>;
	abstract getModels(): Promise<BackendModel[]>;
	abstract getActiveModelKey(): Promise<string | undefined>;
	abstract setModel(key: string): Promise<PromptResult>;
	abstract setThinking(level: ThinkingLevel): Promise<void>;
	abstract getStats(): Promise<NormalizedStats | null>;

	async getEngineSessionId(): Promise<string | undefined> {
		return undefined;
	}

	respondDialog(_payload: Record<string, unknown>): void {
		/* default no-op */
	}
	respondPermission(_id: string, _decision: { allow: boolean }, _input?: unknown): void {
		/* default no-op */
	}

	protected emitEvent(ev: BackendEvent): void {
		this.emit("event", ev);
	}
}
