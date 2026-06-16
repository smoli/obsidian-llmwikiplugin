import * as fs from "fs";
import * as path from "path";

/**
 * Read-only vault tools for the direct OpenAI backend (Phase 2). The OpenAI
 * endpoint is not an agent, so *we* run the tool loop and execute these against
 * the vault — in YOLO mode (no prompt), which is only safe because every path is
 * hard-confined to the working directory by `resolveInVault`.
 */

export interface ToolContext {
	/** Absolute path of the vault working directory; the sandbox boundary. */
	cwd: string;
}

export interface ToolDef {
	name: string;
	description: string;
	/** JSON schema for the function's arguments (Responses API `parameters`). */
	parameters: Record<string, unknown>;
	run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}

const MAX_OUTPUT_CHARS = 30_000;
const MAX_FILE_BYTES = 2_000_000;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILE_BYTES = 1_000_000;

/** Directory names never descended into during a recursive walk. */
const SKIP_DIRS = new Set([".git", "node_modules", ".obsidian", ".trash"]);

function truncate(s: string): string {
	return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + "\n… (truncated)" : s;
}

/**
 * Resolve a (vault-relative or in-vault absolute) path and reject anything that
 * escapes the working directory: `..` traversal, absolute paths outside, and
 * symlinks that point out. This single chokepoint is the safety boundary for
 * YOLO mode — every tool goes through it.
 */
export function resolveInVault(cwd: string, p: unknown): string {
	if (typeof p !== "string" || p.length === 0) throw new Error("a 'path' string is required");
	if (p.includes("\0")) throw new Error("invalid path");
	const root = path.resolve(cwd);
	const candidate = path.resolve(root, p);
	const rel = path.relative(root, candidate);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new Error(`path escapes the vault working directory: ${p}`);
	}
	// If the target (or a symlink along the way) exists, resolve it and re-check.
	let real: string | null = null;
	try {
		real = fs.realpathSync(candidate);
	} catch {
		/* doesn't exist yet — lexical check above already passed */
	}
	if (real) {
		const realRoot = fs.realpathSync(root);
		const relReal = path.relative(realRoot, real);
		if (relReal.startsWith("..") || path.isAbsolute(relReal)) {
			throw new Error(`path escapes the vault (symlink): ${p}`);
		}
		return real;
	}
	return candidate;
}

const readFile: ToolDef = {
	name: "read_file",
	description:
		"Read a UTF-8 text file from the vault. Returns the content with 1-based line numbers. " +
		"Use 'offset' and 'limit' to read a slice of a large file.",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Vault-relative path to the file." },
			offset: { type: "integer", description: "1-based line to start from (optional)." },
			limit: { type: "integer", description: "Max number of lines to return (optional)." },
		},
		required: ["path"],
		additionalProperties: false,
	},
	async run(args, ctx) {
		const abs = resolveInVault(ctx.cwd, args.path);
		const stat = fs.statSync(abs);
		if (stat.isDirectory()) throw new Error(`${String(args.path)} is a directory; use list_dir`);
		if (stat.size > MAX_FILE_BYTES) throw new Error(`file too large (${stat.size} bytes)`);
		const content = fs.readFileSync(abs, "utf8");
		const lines = content.split("\n");
		const offset = Number.isFinite(args.offset as number) ? Math.max(1, Number(args.offset)) : 1;
		const limit = Number.isFinite(args.limit as number) ? Math.max(1, Number(args.limit)) : lines.length;
		const slice = lines.slice(offset - 1, offset - 1 + limit);
		const width = String(offset + slice.length - 1).length;
		const numbered = slice.map((l, i) => `${String(offset + i).padStart(width)}  ${l}`).join("\n");
		return truncate(numbered || "(empty file)");
	},
};

const listDir: ToolDef = {
	name: "list_dir",
	description: "List the entries of a directory in the vault (directories marked with a trailing '/').",
	parameters: {
		type: "object",
		properties: {
			path: { type: "string", description: "Vault-relative directory path. Defaults to the vault root." },
		},
		additionalProperties: false,
	},
	async run(args, ctx) {
		const rel = typeof args.path === "string" && args.path ? args.path : ".";
		const abs = resolveInVault(ctx.cwd, rel);
		const entries = fs.readdirSync(abs, { withFileTypes: true });
		const out = entries
			.map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
			.sort((a, b) => a.localeCompare(b));
		return truncate(out.length ? out.join("\n") : "(empty directory)");
	},
};

const grep: ToolDef = {
	name: "grep",
	description:
		"Search file contents in the vault with a regular expression. Returns matching lines as " +
		"'path:line: text'. Searches *.md and other text files, skipping .git/.obsidian/node_modules.",
	parameters: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Regular expression to search for." },
			path: { type: "string", description: "Vault-relative directory or file to search. Defaults to the vault root." },
			ignoreCase: { type: "boolean", description: "Case-insensitive search (default false)." },
		},
		required: ["pattern"],
		additionalProperties: false,
	},
	async run(args, ctx) {
		if (typeof args.pattern !== "string" || !args.pattern) throw new Error("a 'pattern' is required");
		let re: RegExp;
		try {
			re = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
		} catch (e) {
			throw new Error(`invalid regular expression: ${e instanceof Error ? e.message : String(e)}`);
		}
		const root = ctx.cwd;
		const start = resolveInVault(root, typeof args.path === "string" && args.path ? args.path : ".");
		const matches: string[] = [];

		const searchFile = (abs: string): void => {
			if (matches.length >= MAX_GREP_MATCHES) return;
			let stat: fs.Stats;
			try {
				stat = fs.statSync(abs);
			} catch {
				return;
			}
			if (stat.size > MAX_GREP_FILE_BYTES) return;
			let content: string;
			try {
				content = fs.readFileSync(abs, "utf8");
			} catch {
				return;
			}
			if (content.includes("\0")) return; // skip binary
			const relPath = path.relative(root, abs).split(path.sep).join("/");
			const lines = content.split("\n");
			for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
				if (re.test(lines[i])) matches.push(`${relPath}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
			}
		};

		const walk = (abs: string): void => {
			if (matches.length >= MAX_GREP_MATCHES) return;
			let entries: fs.Dirent[];
			try {
				entries = fs.readdirSync(abs, { withFileTypes: true });
			} catch {
				return;
			}
			for (const e of entries) {
				if (matches.length >= MAX_GREP_MATCHES) return;
				if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
				const child = path.join(abs, e.name);
				if (e.isDirectory()) walk(child);
				else if (e.isFile()) searchFile(child);
			}
		};

		if (fs.statSync(start).isDirectory()) walk(start);
		else searchFile(start);

		const capped = matches.length >= MAX_GREP_MATCHES ? `\n… (stopped at ${MAX_GREP_MATCHES} matches)` : "";
		return truncate(matches.length ? matches.join("\n") + capped : "(no matches)");
	},
};

/** The read-only tool set available in Phase 2. */
export const READ_ONLY_TOOLS: ToolDef[] = [readFile, listDir, grep];

/** Map tool name → definition for execution. */
export const TOOL_MAP: Map<string, ToolDef> = new Map(READ_ONLY_TOOLS.map((t) => [t.name, t]));

/** Function-tool schemas in the Responses API shape (flat `{type:"function", name, …}`). */
export function toolSchemas(tools: ToolDef[] = READ_ONLY_TOOLS): Record<string, unknown>[] {
	return tools.map((t) => ({
		type: "function",
		name: t.name,
		description: t.description,
		parameters: t.parameters,
	}));
}
