// Smoke test for driving Claude Code in streaming-JSON mode, mirroring ClaudeBackend.
import { spawn } from "child_process";
import { StringDecoder } from "string_decoder";

const claude = process.argv[2];
const cwd = process.argv[3];
const agents = process.argv[4]; // path to AGENTS.md or "none"

const args = [
	"--print",
	"--input-format", "stream-json",
	"--output-format", "stream-json",
	"--include-partial-messages",
	"--verbose",
	"--permission-mode", "bypassPermissions",
];
if (agents && agents !== "none") args.push("--append-system-prompt-file", agents);

const proc = spawn(claude, args, { cwd, windowsHide: true, env: process.env });

const dec = new StringDecoder("utf8");
let buf = "";
let text = "";
let deltas = 0;
const seen = new Set();
const samples = {};

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
		try { o = JSON.parse(line); } catch { continue; }
		seen.add(o.type);
		if (o.type === "stream_event") {
			const e = o.event;
			seen.add("  se:" + e?.type);
			if (e?.type === "content_block_start") seen.add("    cbs:" + e.content_block?.type);
			if (e?.type === "content_block_delta" && e.delta?.type === "text_delta") { deltas++; text += e.delta.text ?? ""; }
		}
		if (o.type === "assistant") {
			const tools = (o.message?.content ?? []).filter((b) => b.type === "tool_use").map((b) => `${b.name}(${JSON.stringify(b.input).slice(0,60)})`);
			if (tools.length) console.log("ASSISTANT tool_use:", tools.join(", "));
			if (!samples.assistant) samples.assistant = JSON.stringify(o.message?.content?.map((b)=>b.type));
		}
		if (o.type === "user") {
			const trs = (o.message?.content ?? []).filter((b) => b.type === "tool_result");
			for (const tr of trs) console.log("TOOL_RESULT for", tr.tool_use_id, "isError=", !!tr.is_error);
		}
		if (o.type === "result") {
			console.log("RESULT subtype=", o.subtype, "is_error=", o.is_error, "cost=", o.total_cost_usd, "session=", o.session_id?.slice(0,8));
			console.log("text_delta count:", deltas);
			console.log("TYPES:", [...seen].sort().join("\n  "));
			console.log("FINAL TEXT:", text.trim().slice(0, 300));
			proc.stdin.end();
			proc.kill();
			process.exit(0);
		}
	}
});
proc.stderr.on("data", (c) => process.stderr.write("[err] " + c.toString().slice(0, 200)));
proc.on("exit", (code) => { console.log("exit", code, "seen:", [...seen].join(",")); process.exit(code ?? 0); });

proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Read AGENTS.md and tell me in one sentence what the rule about the raw/ folder is." } }) + "\n");

setTimeout(() => { console.log("TIMEOUT seen:", [...seen].join(",")); proc.kill(); process.exit(1); }, 120000);
