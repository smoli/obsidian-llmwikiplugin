import { spawn } from "child_process";
import { resolveCommand, spawnEnv } from "./exec-env";

export interface GitResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * Run a git command in `cwd` and resolve with its exit code and output.
 * GIT_TERMINAL_PROMPT=0 prevents git from blocking on a credential prompt
 * (it fails fast instead), and a timeout guards against any other hang.
 */
export function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let done = false;

		const proc = spawn(resolveCommand("git"), args, {
			cwd,
			windowsHide: true,
			env: spawnEnv({ GIT_TERMINAL_PROMPT: "0" }),
		});

		const finish = (r: GitResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(r);
		};
		const timer = setTimeout(() => {
			proc.kill();
			finish({ code: -1, stdout, stderr: stderr + "\n(git timed out)" });
		}, timeoutMs);

		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
		proc.on("error", (err) => finish({ code: -1, stdout, stderr: stderr + String(err) }));
		proc.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));
	});
}

/**
 * Run an arbitrary command, optionally feeding `input` on stdin, and capture its
 * output. Used to invoke pi/claude in print mode for a one-shot generation.
 * A bare command / .cmd shim needs a shell on Windows; a .exe is spawned directly.
 */
export function runCapture(
	cmd: string,
	args: string[],
	input: string | null,
	cwd: string,
	timeoutMs = 60_000
): Promise<GitResult> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let done = false;

		const useShell = process.platform === "win32" && !/\.exe$/i.test(cmd);
		const command = useShell ? cmd : resolveCommand(cmd);
		const proc = spawn(command, args, { cwd, shell: useShell, windowsHide: true, env: spawnEnv() });

		const finish = (r: GitResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(r);
		};
		const timer = setTimeout(() => {
			proc.kill();
			finish({ code: -1, stdout, stderr: stderr + "\n(timed out)" });
		}, timeoutMs);

		proc.stdout.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
		proc.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
		proc.on("error", (err) => finish({ code: -1, stdout, stderr: stderr + String(err) }));
		proc.on("close", (code) => finish({ code: code ?? -1, stdout, stderr }));

		try {
			if (input != null) proc.stdin.write(input);
			proc.stdin.end();
		} catch {
			/* ignore */
		}
	});
}
