import { StringDecoder } from "string_decoder";
import { Readable } from "stream";

/**
 * Attach a strict JSONL reader to a stream. Splits on LF only and strips an
 * optional trailing CR (per pi's RPC framing rules; the same framing works for
 * Claude Code's stream-json output). Generic line readers must not be used
 * because they also split on U+2028/U+2029, which are valid inside JSON strings.
 */
export function attachJsonlReader(stream: Readable, onLine: (line: string) => void): void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	stream.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		for (;;) {
			const nl = buffer.indexOf("\n");
			if (nl === -1) break;
			let line = buffer.slice(0, nl);
			buffer = buffer.slice(nl + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (line.length > 0) onLine(line);
		}
	});

	stream.on("end", () => {
		buffer += decoder.end();
		if (buffer.length > 0) onLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
	});
}
