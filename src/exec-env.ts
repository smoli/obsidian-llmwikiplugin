import { execFileSync } from "child_process";
import { existsSync } from "fs";
import { delimiter, join } from "path";
import * as os from "os";

/**
 * On macOS (and often Linux), a GUI-launched app like Obsidian inherits only a
 * minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) — not the PATH from the user's
 * shell profile. Tools installed via Homebrew, npm/nvm/fnm, bun, cargo, etc.
 * are therefore invisible to child processes, so `spawn("claude")` / `spawn("pi")`
 * fails with ENOENT even though the binaries run fine in a terminal.
 *
 * This module recovers a realistic PATH (by asking the login shell and by
 * probing common install dirs) and resolves bare commands to absolute paths.
 */

let cachedPath: string | null = null;

/** Common bin directories a GUI app misses on macOS/Linux. */
function commonDirs(): string[] {
	const home = os.homedir();
	return [
		"/opt/homebrew/bin",
		"/opt/homebrew/sbin",
		"/usr/local/bin",
		"/usr/local/sbin",
		"/usr/bin",
		"/bin",
		"/usr/sbin",
		"/sbin",
		join(home, ".local", "bin"),
		join(home, "bin"),
		join(home, ".npm-global", "bin"),
		join(home, ".bun", "bin"),
		join(home, ".deno", "bin"),
		join(home, ".cargo", "bin"),
		join(home, ".volta", "bin"),
	];
}

/**
 * Ask the user's login shell for its PATH. An interactive login shell sources
 * the profile/rc files (.zprofile, .zshrc, .bash_profile, …) where version
 * managers like nvm/fnm/asdf put the active node — and thus npm-global bins
 * such as claude and pi. A sentinel brackets the value so noise printed by rc
 * files doesn't corrupt it.
 */
function loginShellPath(): string | null {
	if (process.platform === "win32") return null;
	const shell = process.env.SHELL || "/bin/zsh";
	try {
		const out = execFileSync(shell, ["-ilc", 'printf "__LLMPATH__%s__LLMPATH__" "$PATH"'], {
			encoding: "utf8",
			timeout: 5000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const m = out.match(/__LLMPATH__([\s\S]*?)__LLMPATH__/);
		return m && m[1] ? m[1] : null;
	} catch {
		return null;
	}
}

/** PATH enriched with the login shell's entries and existing common dirs, deduped. */
export function enrichedPath(): string {
	if (cachedPath != null) return cachedPath;
	if (process.platform === "win32") {
		cachedPath = process.env.PATH ?? "";
		return cachedPath;
	}
	const parts: string[] = [];
	const add = (p: string | null | undefined): void => {
		if (!p) return;
		for (const d of p.split(delimiter)) if (d && !parts.includes(d)) parts.push(d);
	};
	add(loginShellPath());
	add(process.env.PATH);
	for (const d of commonDirs()) if (existsSync(d) && !parts.includes(d)) parts.push(d);
	cachedPath = parts.join(delimiter);
	return cachedPath;
}

/** `process.env` with the enriched PATH applied, plus any extra overrides. */
export function spawnEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
	return { ...process.env, PATH: enrichedPath(), ...extra };
}

/**
 * Resolve a bare command name to an absolute executable path using the enriched
 * PATH. Anything that already contains a path separator is returned unchanged,
 * as is a name that can't be located (so spawn still produces a clear ENOENT).
 */
export function resolveCommand(cmd: string): string {
	if (process.platform === "win32") return cmd;
	if (cmd.includes("/")) return cmd;
	for (const dir of enrichedPath().split(delimiter)) {
		if (!dir) continue;
		const full = join(dir, cmd);
		try {
			if (existsSync(full)) return full;
		} catch {
			/* ignore */
		}
	}
	return cmd;
}
