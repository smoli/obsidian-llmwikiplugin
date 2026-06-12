// Standalone smoke test that mirrors how the plugin drives pi over RPC:
// long-lived process, JSONL framing, stream until agent_end.
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

const cwd = process.argv[2] || process.cwd();
const proc = spawn("pi", ["--mode", "rpc", "--no-session", "--thinking", "off"], {
	cwd,
	shell: process.platform === "win32",
	windowsHide: true,
	env: process.env,
});

const dec = new StringDecoder("utf8");
let buf = "";
let text = "";
const seen = new Set();

proc.stdout.on("data", (chunk) => {
	buf += dec.write(chunk);
	for (;;) {
		const nl = buf.indexOf("\n");
		if (nl === -1) break;
		let line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (!line) continue;
		let o;
		try {
			o = JSON.parse(line);
		} catch {
			continue;
		}
		seen.add(o.type);
		if (o.type === "tool_execution_start") console.log("TOOL_START:", o.toolName, JSON.stringify(o.args));
		else if (o.type === "tool_execution_end") console.log("TOOL_END:", o.toolName, "isError=", o.isError);
		else if (o.type === "message_update" && o.assistantMessageEvent?.type === "text_delta")
			text += o.assistantMessageEvent.delta ?? "";
		else if (o.type === "agent_end") {
			console.log("AGENT_END");
			console.log("EVENT TYPES:", [...seen].sort().join(", "));
			console.log("ASSISTANT TEXT:", text.trim());
			proc.stdin.end();
			proc.kill();
			process.exit(0);
		}
	}
});
proc.stderr.on("data", (c) => process.stderr.write("[stderr] " + c.toString()));
proc.on("exit", (code) => {
	console.log("process exit", code, "without agent_end. seen:", [...seen].sort().join(", "));
	process.exit(code ?? 0);
});

proc.stdin.write(
	JSON.stringify({
		id: "p",
		type: "prompt",
		message: "In one short sentence, list the folders at the wiki root per AGENTS.md. Read it if needed.",
	}) + "\n"
);

setTimeout(() => {
	console.log("TIMEOUT. seen:", [...seen].sort().join(", "), "text:", text.slice(0, 200));
	proc.kill();
	process.exit(1);
}, 85000);
