/** Structured response shapes a schema persona may emit (see RESPONSE_SCHEMA_INSTRUCTION). */
export type ResponseEnvelope =
	| { type: "message"; text: string }
	| { type: "single_choice"; text: string; options: string[] }
	| { type: "multi_choice"; text: string; options: string[] };

const MARKER_RE = /^>{2,3}\s*(message|single[_-]?choice|multi[_-]?choice|single|multi)\s*:?\s*$/i;
const OPTION_RE = /^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/;

function normalizeMarker(raw: string): ResponseEnvelope["type"] {
	const m = raw.toLowerCase();
	if (m.includes("multi")) return "multi_choice";
	if (m.includes("single")) return "single_choice";
	return "message";
}

/**
 * Parse a structured response into a sequence of envelopes using the marker
 * protocol (a `>>> <type>` line per block; `- option` lines for choices). This
 * is deliberately tolerant: text is taken verbatim (no JSON escaping, so rich
 * prose with quotes never breaks it), and a reply with no markers degrades to a
 * single plain message. Returns an empty array only for empty input.
 */
export function parseResponseEnvelopes(raw: string): ResponseEnvelope[] {
	let s = raw.trim();
	if (!s) return [];
	// Unwrap a single code fence wrapping the whole reply, if present.
	const fence = s.match(/^```[a-z]*\s*([\s\S]*?)\s*```$/i);
	if (fence) s = fence[1].trim();

	const envs: ResponseEnvelope[] = [];
	let type: ResponseEnvelope["type"] = "message";
	let textLines: string[] = [];
	let options: string[] = [];
	let sawMarker = false;

	const flush = () => {
		const text = textLines.join("\n").trim();
		if (type === "message") {
			if (text) envs.push({ type: "message", text });
		} else if (options.length) {
			envs.push({ type, text, options });
		} else if (text) {
			envs.push({ type: "message", text });
		}
		textLines = [];
		options = [];
	};

	for (const line of s.split(/\r?\n/)) {
		const m = line.match(MARKER_RE);
		if (m) {
			flush();
			type = normalizeMarker(m[1]);
			sawMarker = true;
			continue;
		}
		if (type !== "message") {
			const opt = line.match(OPTION_RE);
			if (opt) {
				options.push(opt[1].trim());
				continue;
			}
		}
		textLines.push(line);
	}
	flush();

	// No markers at all → render the whole reply as one markdown message.
	if (!sawMarker) return s ? [{ type: "message", text: s }] : [];
	return envs;
}

/**
 * Markdown rendering of envelopes for the transcript (saved chats + session
 * restore). Choices become a numbered list — readable in saved chats; on restore
 * they render as a static list (the live chips come from renderStructuredInto).
 */
export function envelopesToTranscript(envs: ResponseEnvelope[]): string {
	return envs
		.map((env) => {
			if (env.type === "message") return env.text.trim();
			const list = env.options.map((o, i) => `${i + 1}. ${o}`).join("\n");
			return `${env.text.trim()}\n\n${list}`;
		})
		.filter(Boolean)
		.join("\n\n");
}
