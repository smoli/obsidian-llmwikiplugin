import {
	AgentBackend,
	BackendCapabilities,
	BackendModel,
	BaseBackend,
	NormalizedStats,
	PromptResult,
} from "./backend";
import { PiClient, PiClientOptions } from "./pi-client";
import { ExtensionUIRequest, RpcEvent } from "./rpc-types";
import { ThinkingLevel } from "./rpc-types";

/** Adapts the pi RPC client to the engine-neutral AgentBackend interface. */
export class PiBackend extends BaseBackend implements AgentBackend {
	readonly engineName = "pi";
	readonly capabilities: BackendCapabilities = { thinking: true, liveModels: true };

	private client: PiClient;

	constructor(opts: PiClientOptions) {
		super();
		this.client = new PiClient(opts);
		this.client.on("event", (ev: RpcEvent) => this.translate(ev));
		this.client.on("ui", (req: ExtensionUIRequest) => this.emit("dialog", req));
		this.client.on("error", (err: Error) => this.emit("error", err));
		this.client.on("exit", (code: number | null) => this.emit("exit", code));
		this.client.on("stderr", () => {
			/* swallowed; surfaced via lastStderr */
		});
	}

	get running(): boolean {
		return this.client.running;
	}
	get lastStderr(): string {
		return this.client.lastStderr;
	}

	start(): void {
		this.client.start();
	}
	dispose(): void {
		this.client.dispose();
		this.removeAllListeners();
	}

	async prompt(text: string, steering = false): Promise<PromptResult> {
		const res = await this.client.prompt(text, steering ? "steer" : undefined);
		return { ok: res.success, error: res.error };
	}

	abort(): void {
		void this.client.abort();
	}

	async newSession(): Promise<void> {
		await this.client.newSession();
	}

	async getModels(): Promise<BackendModel[]> {
		const models = await this.client.getAvailableModels();
		return models.map((m) => ({
			key: `${m.provider} ${m.id}`,
			label: `${m.name ?? m.id} · ${m.provider}`,
		}));
	}

	async getActiveModelKey(): Promise<string | undefined> {
		try {
			const state = await this.client.getState();
			const active = state.data?.model;
			return active ? `${active.provider} ${active.id}` : undefined;
		} catch {
			return undefined;
		}
	}

	async setModel(key: string): Promise<PromptResult> {
		const [provider, id] = key.split(" ");
		if (!provider || !id) return { ok: false, error: "Invalid model key" };
		const res = await this.client.setModel(provider, id);
		return { ok: res.success, error: res.error };
	}

	async setThinking(level: ThinkingLevel): Promise<void> {
		if (this.client.running) await this.client.setThinkingLevel(level);
	}

	async getStats(): Promise<NormalizedStats | null> {
		try {
			const res = await this.client.getSessionStats();
			if (!res.success) return null;
			const d = res.data ?? {};
			return {
				tokensTotal: d.tokens?.total,
				cost: typeof d.cost === "number" ? d.cost : undefined,
				contextPercent: d.contextUsage?.percent ?? null,
			};
		} catch {
			return null;
		}
	}

	respondDialog(payload: Record<string, unknown>): void {
		this.client.respondUI(payload);
	}

	// --- pi raw event → normalized event ---

	private translate(ev: RpcEvent): void {
		switch (ev.type) {
			case "agent_start":
				this.emitEvent({ type: "run-start" });
				break;

			case "message_update": {
				const e = ev.assistantMessageEvent;
				if (!e) break;
				switch (e.type) {
					case "text_start":
						this.emitEvent({ type: "text-start" });
						break;
					case "text_delta":
						this.emitEvent({ type: "text-delta", delta: e.delta ?? "" });
						break;
					case "text_end":
						this.emitEvent({ type: "text-end", content: typeof e.content === "string" ? e.content : undefined });
						break;
					case "thinking_delta":
						this.emitEvent({ type: "thinking-delta", delta: e.delta ?? "" });
						break;
					case "error":
						this.emitEvent({ type: "error", message: e.reason ?? "error" });
						break;
				}
				break;
			}

			case "message_end":
				if (ev.message?.role === "assistant" && ev.message?.stopReason === "error") {
					this.emitEvent({ type: "error", message: ev.message.errorMessage ?? "The model returned an error." });
				}
				break;

			case "tool_execution_start":
				this.emitEvent({ type: "tool-start", id: ev.toolCallId, name: ev.toolName, args: ev.args });
				break;
			case "tool_execution_update":
				this.emitEvent({ type: "tool-update", id: ev.toolCallId, text: this.toolText(ev.partialResult) });
				break;
			case "tool_execution_end":
				this.emitEvent({
					type: "tool-end",
					id: ev.toolCallId,
					text: this.toolText(ev.result),
					isError: !!ev.isError,
				});
				break;

			case "agent_end":
				this.emitEvent({ type: "run-end" });
				break;

			case "queue_update":
				if ((ev.steering?.length ?? 0) + (ev.followUp?.length ?? 0) > 0) {
					this.emitEvent({
						type: "status",
						text: `Queued · steer:${ev.steering?.length ?? 0} followUp:${ev.followUp?.length ?? 0}`,
					});
				}
				break;
			case "compaction_start":
				this.emitEvent({ type: "status", text: "Compacting context…" });
				break;
			case "compaction_end":
				this.emitEvent({ type: "status", text: "Context compacted." });
				break;
			case "auto_retry_start":
				this.emitEvent({ type: "status", text: `Retrying (attempt ${ev.attempt}/${ev.maxAttempts})…` });
				break;
			case "auto_retry_end":
				if (!ev.success) this.emitEvent({ type: "error", message: `Retry failed: ${ev.finalError ?? ""}` });
				break;
			case "extension_error":
				this.emitEvent({ type: "notice", message: `Extension error: ${ev.error ?? "unknown"}`, level: "error" });
				break;
		}
	}

	private toolText(result: any): string {
		const content = result?.content;
		if (Array.isArray(content)) {
			return content
				.filter((c: any) => c?.type === "text" && typeof c.text === "string")
				.map((c: any) => c.text)
				.join("\n");
		}
		return "";
	}
}
