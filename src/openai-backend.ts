import * as https from "https";
import * as http from "http";
import * as fs from "fs";
import { URL } from "url";
import {
	BackendCapabilities,
	BackendModel,
	BaseBackend,
	NormalizedStats,
	PromptResult,
} from "./backend";
import { ThinkingLevel } from "./rpc-types";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

export type OpenAiAuth =
	| { mode: "apikey"; apiKey: string; baseUrl: string }
	| {
			mode: "subscription";
			accessToken: string;
			accountId: string;
			/** Force a token refresh; returns the fresh token or null if it failed. */
			refresh: () => Promise<{ accessToken: string; accountId: string } | null>;
	  };

export interface OpenAiBackendOptions {
	auth: OpenAiAuth;
	model: string;
	cwd: string;
	/** Absolute path to a system-prompt file (persona / AGENTS.md), if any. */
	systemPromptFile?: string;
	/** Prior response id (API-key mode server-side state). */
	resumeSessionId?: string;
	/** Prior turns to seed the conversation (subscription mode has no server state). */
	history?: { role: "user" | "assistant"; text: string }[];
}

interface Turn {
	role: "user" | "assistant";
	text: string;
}

/**
 * Talks to OpenAI directly. Two auth modes:
 *  - **apikey**: Responses API with `store: true` + `previous_response_id` (server
 *    keeps the conversation; we send only the new turn).
 *  - **subscription**: the Codex ChatGPT backend, which forbids `store: true`, so
 *    we replay the full message history each turn. Token refreshed on 401.
 * Phase 1: streaming text only — no tools yet.
 */
export class OpenAiBackend extends BaseBackend {
	readonly engineName = "openai";
	readonly capabilities: BackendCapabilities = { thinking: false, liveModels: false };

	private model: string;
	private system = "";
	private previousResponseId?: string;
	private messages: Turn[] = [];
	private accessToken: string;
	private accountId: string;
	private started = false;
	private busy = false;
	private aborted = false;
	private req: http.ClientRequest | null = null;
	private lastStats: NormalizedStats | null = null;
	private stderr = "";

	constructor(private opts: OpenAiBackendOptions) {
		super();
		this.model = opts.model || "gpt-5";
		this.previousResponseId = opts.resumeSessionId;
		this.accessToken = opts.auth.mode === "subscription" ? opts.auth.accessToken : "";
		this.accountId = opts.auth.mode === "subscription" ? opts.auth.accountId : "";
	}

	get running(): boolean {
		return this.started;
	}
	get lastStderr(): string {
		return this.stderr;
	}

	start(): void {
		if (this.opts.systemPromptFile) {
			try {
				this.system = fs.readFileSync(this.opts.systemPromptFile, "utf8");
			} catch {
				/* no system prompt */
			}
		}
		if (this.opts.auth.mode === "subscription" && this.opts.history) {
			this.messages = this.opts.history.map((m) => ({ role: m.role, text: m.text }));
		}
		this.started = true;
	}

	dispose(): void {
		this.abort();
		this.started = false;
	}

	abort(): void {
		this.aborted = true;
		this.req?.destroy();
		this.req = null;
	}

	async newSession(): Promise<void> {
		this.previousResponseId = undefined;
		this.messages = [];
		this.lastStats = null;
	}

	async prompt(text: string, _steering = false): Promise<PromptResult> {
		if (!this.started) return { ok: false, error: "OpenAI backend not started." };
		if (this.busy) return { ok: false, error: "A response is already in progress." };

		this.busy = true;
		this.aborted = false;
		let textOpen = false;
		let assistant = "";
		this.emitEvent({ type: "run-start" });

		const onEvent = (data: any) => {
			switch (data.type) {
				case "response.created":
					if (data.response?.id) this.previousResponseId = data.response.id;
					break;
				case "response.output_text.delta":
					if (!textOpen) {
						this.emitEvent({ type: "text-start" });
						textOpen = true;
					}
					if (typeof data.delta === "string") {
						assistant += data.delta;
						this.emitEvent({ type: "text-delta", delta: data.delta });
					}
					break;
				case "response.completed":
					if (data.response?.id) this.previousResponseId = data.response.id;
					this.applyUsage(data.response?.usage);
					break;
				case "response.failed":
				case "error": {
					const msg = data.response?.error?.message ?? data.error?.message ?? data.message ?? "OpenAI error";
					throw new Error(msg);
				}
			}
		};

		try {
			if (this.opts.auth.mode === "subscription") this.messages.push({ role: "user", text });
			await this.runRequest(text, onEvent);
			if (this.opts.auth.mode === "subscription" && assistant.trim()) {
				this.messages.push({ role: "assistant", text: assistant });
			}
			if (textOpen) this.emitEvent({ type: "text-end" });
			this.emitEvent({ type: "run-end" });
			return { ok: true };
		} catch (err) {
			if (textOpen) this.emitEvent({ type: "text-end" });
			if (!this.aborted) {
				this.stderr = err instanceof Error ? err.message : String(err);
				this.emitEvent({ type: "error", message: this.stderr });
			}
			this.emitEvent({ type: "run-end" });
			return { ok: false, error: this.stderr };
		} finally {
			this.busy = false;
			this.req = null;
		}
	}

	async getEngineSessionId(): Promise<string | undefined> {
		// Subscription mode has no server-side state to resume.
		return this.opts.auth.mode === "apikey" ? this.previousResponseId : undefined;
	}

	async getModels(): Promise<BackendModel[]> {
		return [{ key: this.model, label: this.model }];
	}
	async getActiveModelKey(): Promise<string | undefined> {
		return this.model;
	}
	async setModel(key: string): Promise<PromptResult> {
		this.model = key;
		return { ok: true };
	}
	async setThinking(_level: ThinkingLevel): Promise<void> {
		/* reasoning models handle this differently; Phase 5 */
	}
	async getStats(): Promise<NormalizedStats | null> {
		return this.lastStats;
	}

	// --------------------------------------------------------------- internals

	/** Send the request; on a 401 in subscription mode, refresh the token and retry once. */
	private async runRequest(text: string, onEvent: (data: any) => void): Promise<void> {
		try {
			await this.streamRequest(this.buildUrl(), this.buildHeaders(), this.buildBody(text), onEvent);
		} catch (err: any) {
			if (this.opts.auth.mode === "subscription" && err?.status === 401 && !this.aborted) {
				const fresh = await this.opts.auth.refresh();
				if (!fresh) throw new Error("ChatGPT session expired — sign in again in settings.");
				this.accessToken = fresh.accessToken;
				this.accountId = fresh.accountId;
				await this.streamRequest(this.buildUrl(), this.buildHeaders(), this.buildBody(text), onEvent);
			} else {
				throw err;
			}
		}
	}

	private buildUrl(): string {
		if (this.opts.auth.mode === "subscription") return CODEX_URL;
		return `${this.opts.auth.baseUrl}/responses`;
	}

	private buildHeaders(): Record<string, string> {
		if (this.opts.auth.mode === "subscription") {
			return {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				Authorization: `Bearer ${this.accessToken}`,
				"chatgpt-account-id": this.accountId,
				originator: "pi",
				"OpenAI-Beta": "responses=experimental",
			};
		}
		return {
			"Content-Type": "application/json",
			Accept: "text/event-stream",
			Authorization: `Bearer ${this.opts.auth.apiKey}`,
		};
	}

	private buildBody(text: string): string {
		if (this.opts.auth.mode === "subscription") {
			return JSON.stringify({
				model: this.model,
				instructions: this.system || "You are a helpful assistant.",
				input: this.messages.map((m) => ({
					role: m.role,
					content: [{ type: m.role === "user" ? "input_text" : "output_text", text: m.text }],
				})),
				stream: true,
				store: false,
				include: ["reasoning.encrypted_content"],
			});
		}
		return JSON.stringify({
			model: this.model,
			instructions: this.system || undefined,
			input: text,
			stream: true,
			store: true,
			previous_response_id: this.previousResponseId || undefined,
		});
	}

	private applyUsage(usage: any): void {
		if (!usage) return;
		const total = usage.total_tokens ?? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
		this.lastStats = { tokensTotal: total || undefined, cost: undefined, contextPercent: null };
		this.emitEvent({ type: "stats", stats: this.lastStats });
	}

	private parseEvent(raw: string): any | null {
		const dataLines = raw
			.split("\n")
			.filter((l) => l.startsWith("data:"))
			.map((l) => l.slice(5).trim());
		if (dataLines.length === 0) return null;
		const payload = dataLines.join("\n");
		if (payload === "[DONE]") return null;
		try {
			return JSON.parse(payload);
		} catch {
			return null;
		}
	}

	/** POST and feed each SSE event's parsed JSON to onEvent. Rejects with `.status` on HTTP error. */
	private streamRequest(urlStr: string, headers: Record<string, string>, payload: string, onEvent: (data: any) => void): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const url = new URL(urlStr);
			const mod = url.protocol === "http:" ? http : https;
			const req = mod.request(
				url,
				{ method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(payload) } },
				(res) => {
					const status = res.statusCode ?? 0;
					if (status >= 400) {
						let errBody = "";
						res.setEncoding("utf8");
						res.on("data", (c) => (errBody += c));
						res.on("end", () => {
							const e = new Error(`OpenAI ${status}: ${errBody.slice(0, 400)}`) as Error & { status?: number };
							e.status = status;
							reject(e);
						});
						return;
					}
					res.setEncoding("utf8");
					let buffer = "";
					res.on("data", (chunk: string) => {
						buffer += chunk;
						let idx: number;
						while ((idx = buffer.indexOf("\n\n")) !== -1) {
							const evt = buffer.slice(0, idx);
							buffer = buffer.slice(idx + 2);
							if (!evt.trim()) continue;
							const data = this.parseEvent(evt);
							if (data) {
								try {
									onEvent(data);
								} catch (err) {
									req.destroy();
									reject(err);
									return;
								}
							}
						}
					});
					res.on("end", () => resolve());
					res.on("error", reject);
				}
			);
			req.on("error", (err) => reject(err));
			this.req = req;
			req.write(payload);
			req.end();
		});
	}
}
