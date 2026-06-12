import { App } from "obsidian";

/** A reusable, one-click prompt. */
export interface StandardPrompt {
	id: string;
	label: string;
	prompt: string;
}

/** Shape of the JSON config file stored at the vault root. */
interface PromptFile {
	prompts: StandardPrompt[];
}

/** Prompts seeded into a freshly created config file (wiki-oriented defaults). */
export const DEFAULT_PROMPTS: StandardPrompt[] = [
	{
		id: "lint",
		label: "Lint wiki",
		prompt:
			"Lint and audit the wiki according to AGENTS.md: find contradictions, orphan pages, missing concept pages, outdated claims, and page-format violations. Report findings as a numbered list with suggested fixes.",
	},
	{
		id: "ingest",
		label: "Ingest raw/",
		prompt:
			"Check the raw/ folder for any source documents that have not been ingested yet. For each new source, follow the ingest workflow in AGENTS.md. Discuss key takeaways with me before writing anything.",
	},
	{
		id: "index",
		label: "Refresh index",
		prompt:
			"Review wiki/index.md and each wiki subfolder index against the actual pages on disk. Update them so every page is listed with a one-line description, and report what you changed.",
	},
];

/**
 * Loads and saves the list of standard prompts from a JSON file at the vault
 * root. Read/write goes through the vault adapter so the file lives inside the
 * vault and is hand-editable.
 */
export class PromptStore {
	private prompts: StandardPrompt[] = [];
	private loaded = false;

	constructor(private app: App, private getFileName: () => string) {}

	get fileName(): string {
		const name = (this.getFileName() || "pi-agent-prompts.json").trim();
		return name.replace(/^[\\/]+/, "");
	}

	getAll(): StandardPrompt[] {
		return this.prompts;
	}

	isLoaded(): boolean {
		return this.loaded;
	}

	/** Load prompts from the vault file, seeding defaults if it doesn't exist. */
	async load(): Promise<StandardPrompt[]> {
		const path = this.fileName;
		try {
			if (await this.app.vault.adapter.exists(path)) {
				const raw = await this.app.vault.adapter.read(path);
				const data = JSON.parse(raw) as PromptFile;
				this.prompts = this.normalize(data?.prompts);
			} else {
				this.prompts = [...DEFAULT_PROMPTS];
				await this.save();
			}
		} catch (err) {
			console.error("[pi-agent] failed to read prompts file:", err);
			// Keep whatever we had; don't clobber a malformed file by overwriting.
		}
		this.loaded = true;
		return this.prompts;
	}

	/** Persist the given prompts (or the current set) to the vault file. */
	async save(prompts?: StandardPrompt[]): Promise<void> {
		if (prompts) this.prompts = this.normalize(prompts);
		const body = JSON.stringify({ prompts: this.prompts } satisfies PromptFile, null, 2) + "\n";
		await this.app.vault.adapter.write(this.fileName, body);
	}

	private normalize(list: unknown): StandardPrompt[] {
		if (!Array.isArray(list)) return [];
		const out: StandardPrompt[] = [];
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const label = typeof (item as any).label === "string" ? (item as any).label.trim() : "";
			const prompt = typeof (item as any).prompt === "string" ? (item as any).prompt : "";
			if (!label && !prompt) continue;
			out.push({
				id: typeof (item as any).id === "string" && (item as any).id ? (item as any).id : makeId(),
				label: label || "(unnamed)",
				prompt,
			});
		}
		return out;
	}
}

let idCounter = 0;
export function makeId(): string {
	idCounter += 1;
	return `p${Date.now().toString(36)}${idCounter}`;
}
