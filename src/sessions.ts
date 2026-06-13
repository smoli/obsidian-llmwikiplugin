import { App } from "obsidian";

export interface SessionMessage {
	role: "user" | "assistant";
	text: string;
}

/** A persisted chat session: display record + the engine id needed to resume it. */
export interface SavedSession {
	id: string;
	name: string;
	engine: "pi" | "claude";
	/** claude session_id, or pi session id/file — used to resume the conversation. */
	engineSessionId?: string;
	model: string;
	persona: string;
	transcript: SessionMessage[];
	createdAt: number;
	updatedAt: number;
}

/**
 * Stores chat sessions as JSON in the plugin's config directory (not in the
 * user's vault). Writes are debounced; call flush() to persist immediately.
 */
export class SessionStore {
	private sessions: SavedSession[] = [];
	private saveTimer: number | null = null;

	constructor(private app: App, private dir: string) {}

	private get filePath(): string {
		return `${this.dir}/sessions.json`;
	}

	async load(): Promise<void> {
		try {
			if (await this.app.vault.adapter.exists(this.filePath)) {
				const raw = await this.app.vault.adapter.read(this.filePath);
				const data = JSON.parse(raw);
				if (Array.isArray(data?.sessions)) this.sessions = data.sessions;
			}
		} catch (err) {
			console.error("[llm-agent] failed to read sessions.json:", err);
		}
	}

	/** All sessions, most recently updated first. */
	getAll(): SavedSession[] {
		return [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	get(id: string): SavedSession | undefined {
		return this.sessions.find((s) => s.id === id);
	}

	upsert(session: SavedSession): void {
		const i = this.sessions.findIndex((s) => s.id === session.id);
		if (i >= 0) this.sessions[i] = session;
		else this.sessions.push(session);
		this.scheduleSave();
	}

	remove(id: string): void {
		this.sessions = this.sessions.filter((s) => s.id !== id);
		this.scheduleSave();
	}

	/** Drop every session except the given id. Returns how many were removed. */
	keepOnly(id: string): number {
		const before = this.sessions.length;
		this.sessions = this.sessions.filter((s) => s.id === id);
		this.scheduleSave();
		return before - this.sessions.length;
	}

	private scheduleSave(): void {
		if (this.saveTimer != null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, 800);
	}

	async flush(): Promise<void> {
		if (this.saveTimer != null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		try {
			await this.app.vault.adapter.write(this.filePath, JSON.stringify({ sessions: this.sessions }, null, 2));
		} catch (err) {
			console.error("[llm-agent] failed to write sessions.json:", err);
		}
	}
}

export function newSessionId(): string {
	try {
		return crypto.randomUUID();
	} catch {
		return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
	}
}
