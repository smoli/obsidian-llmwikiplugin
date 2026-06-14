// Minimal type definitions for pi's RPC protocol (docs/rpc.md).
// Only the fields the plugin actually reads are typed precisely; the rest are
// loosely typed to stay forward-compatible with pi version bumps.

export interface PiModel {
	id: string;
	name: string;
	provider: string;
	api?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
	input?: string[];
	cost?: Record<string, number>;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/** A command sent to pi's stdin. */
export interface RpcCommand {
	id?: string;
	type: string;
	[key: string]: unknown;
}

/** A response to a command (correlated by `id`). */
export interface RpcResponse {
	type: "response";
	command: string;
	id?: string;
	success: boolean;
	error?: string;
	data?: any;
}

/** Any streamed agent event (message_update, tool_execution_*, etc.). */
export interface RpcEvent {
	type: string;
	[key: string]: any;
}

/** An extension UI request emitted on stdout (select/confirm/input/editor/notify/...). */
export interface ExtensionUIRequest {
	type: "extension_ui_request";
	id: string;
	method:
		| "select"
		| "confirm"
		| "input"
		| "editor"
		| "notify"
		| "setStatus"
		| "setWidget"
		| "setTitle"
		| "set_editor_text";
	title?: string;
	message?: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
	timeout?: number;
	/** Optional changed-file list to show (used by the commit dialog). */
	files?: { status: string; path: string }[];
	[key: string]: unknown;
}

export type StreamLine = RpcResponse | RpcEvent | ExtensionUIRequest;

export function isResponse(line: StreamLine): line is RpcResponse {
	return line.type === "response";
}

export function isExtensionUIRequest(line: StreamLine): line is ExtensionUIRequest {
	return line.type === "extension_ui_request";
}
