import * as crypto from "crypto";
import * as http from "http";
import * as https from "https";
import { URL, URLSearchParams } from "url";

// Constants mirror OpenAI's Codex CLI "Sign in with ChatGPT" OAuth flow (the same
// one pi uses). This authenticates a ChatGPT subscription against the Codex
// backend — it uses OpenAI's first-party client id and an undocumented endpoint.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTH_BASE = "https://auth.openai.com";
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`;
const TOKEN_URL = `${AUTH_BASE}/oauth/token`;
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const CALLBACK_PORT = 1455;
const SCOPE = "openid profile email offline_access";
const JWT_CLAIM = "https://api.openai.com/auth";

export interface OpenAiCodexCredentials {
	access: string;
	refresh: string;
	/** Epoch ms when the access token expires. */
	expires: number;
	accountId: string;
}

function base64url(buf: Buffer): string {
	return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pkce(): { verifier: string; challenge: string } {
	const verifier = base64url(crypto.randomBytes(64));
	const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());
	return { verifier, challenge };
}

function decodeJwtPayload(token: string): any | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		return JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
	} catch {
		return null;
	}
}

export function accountIdFromAccess(access: string): string | null {
	const payload = decodeJwtPayload(access);
	const id = payload?.[JWT_CLAIM]?.chatgpt_account_id;
	return typeof id === "string" && id ? id : null;
}

/** POST application/x-www-form-urlencoded and parse the JSON response (Node, no CORS). */
function postForm(urlStr: string, params: Record<string, string>): Promise<any> {
	return new Promise((resolve, reject) => {
		const url = new URL(urlStr);
		const payload = new URLSearchParams(params).toString();
		const req = https.request(
			url,
			{
				method: "POST",
				headers: {
					"Content-Type": "application/x-www-form-urlencoded",
					"Content-Length": Buffer.byteLength(payload),
					Accept: "application/json",
				},
			},
			(res) => {
				let body = "";
				res.setEncoding("utf8");
				res.on("data", (c) => (body += c));
				res.on("end", () => {
					if ((res.statusCode ?? 0) >= 400) {
						reject(new Error(`OpenAI auth ${res.statusCode}: ${body.slice(0, 300)}`));
						return;
					}
					try {
						resolve(JSON.parse(body));
					} catch (e) {
						reject(new Error("Invalid token response"));
					}
				});
				res.on("error", reject);
			}
		);
		req.on("error", reject);
		req.write(payload);
		req.end();
	});
}

function toCredentials(json: any): OpenAiCodexCredentials {
	if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== "number") {
		throw new Error("Token response missing fields");
	}
	const access = json.access_token as string;
	const accountId = accountIdFromAccess(access);
	if (!accountId) throw new Error("Could not read ChatGPT account id from token");
	return {
		access,
		refresh: json.refresh_token,
		expires: Date.now() + json.expires_in * 1000,
		accountId,
	};
}

/** Refresh an expired/expiring access token. */
export async function refreshOpenAiCodex(refreshToken: string): Promise<OpenAiCodexCredentials> {
	const json = await postForm(TOKEN_URL, {
		grant_type: "refresh_token",
		refresh_token: refreshToken,
		client_id: CLIENT_ID,
	});
	// Refresh responses sometimes omit a new refresh_token — keep the old one.
	if (!json.refresh_token) json.refresh_token = refreshToken;
	return toCredentials(json);
}

/**
 * Run the browser OAuth flow: open `openUrl(authUrl)`, catch the localhost
 * callback, exchange the code for tokens. Rejects on timeout/cancel.
 */
export function loginOpenAiCodex(openUrl: (url: string) => void, timeoutMs = 5 * 60_000): Promise<OpenAiCodexCredentials> {
	return new Promise((resolve, reject) => {
		const { verifier, challenge } = pkce();
		const state = crypto.randomBytes(16).toString("hex");

		const authUrl = new URL(AUTHORIZE_URL);
		authUrl.searchParams.set("response_type", "code");
		authUrl.searchParams.set("client_id", CLIENT_ID);
		authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
		authUrl.searchParams.set("scope", SCOPE);
		authUrl.searchParams.set("code_challenge", challenge);
		authUrl.searchParams.set("code_challenge_method", "S256");
		authUrl.searchParams.set("state", state);
		authUrl.searchParams.set("id_token_add_organizations", "true");
		authUrl.searchParams.set("codex_cli_simplified_flow", "true");
		authUrl.searchParams.set("originator", "pi");

		let settled = false;
		const finish = (fn: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				server.close();
			} catch {
				/* ignore */
			}
			fn();
		};

		const server = http.createServer((req, res) => {
			const u = new URL(req.url || "", "http://localhost");
			if (u.pathname !== "/auth/callback") {
				res.statusCode = 404;
				res.end("Not found");
				return;
			}
			const respond = (msg: string) => {
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				res.end(`<html><body style="font-family:sans-serif;padding:2rem">${msg}</body></html>`);
			};
			if (u.searchParams.get("state") !== state) {
				res.statusCode = 400;
				respond("State mismatch — please retry the login.");
				return;
			}
			const code = u.searchParams.get("code");
			if (!code) {
				res.statusCode = 400;
				respond("Missing authorization code.");
				return;
			}
			res.statusCode = 200;
			respond("ChatGPT sign-in complete — you can close this window and return to Obsidian.");
			void (async () => {
				try {
					const json = await postForm(TOKEN_URL, {
						grant_type: "authorization_code",
						client_id: CLIENT_ID,
						code,
						code_verifier: verifier,
						redirect_uri: REDIRECT_URI,
					});
					const creds = toCredentials(json);
					finish(() => resolve(creds));
				} catch (err) {
					finish(() => reject(err));
				}
			})();
		});

		server.on("error", (err) => finish(() => reject(err)));
		const timer = setTimeout(() => finish(() => reject(new Error("Login timed out."))), timeoutMs);

		server.listen(CALLBACK_PORT, "127.0.0.1", () => {
			try {
				openUrl(authUrl.toString());
			} catch {
				/* the URL is also surfaced by the caller */
			}
		});
	});
}
