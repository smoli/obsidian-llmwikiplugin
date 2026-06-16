import * as fs from "fs";
import * as os from "os";
import * as path from "path";

/**
 * Secrets are stored OUTSIDE the vault — the vault is typically a git repo and
 * its `.obsidian/plugins/<id>/data.json` is tracked, so an API key kept there
 * would leak into commits. This file lives in the user's home directory instead.
 *
 * On top of that, when Electron's `safeStorage` is reachable we encrypt the
 * payload with the OS keychain (Windows DPAPI / macOS Keychain / Linux
 * libsecret), so the file is not plaintext at rest. If `safeStorage` is not
 * available we fall back to plaintext (still outside the vault) so login never
 * breaks. The encrypted form is tied to the OS user, so it is non-portable by
 * design — copying the file to another machine/account won't decrypt.
 */
const DIR = path.join(os.homedir(), ".sts-llm-wiki");
const FILE = path.join(DIR, "credentials.json");

export interface Secrets {
	openaiApiKey?: string;
	openaiOAuth?: { access: string; refresh: string; expires: number; accountId: string } | null;
}

/** Minimal shape of Electron's safeStorage we rely on. */
interface SafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plain: string): Buffer;
	decryptString(encrypted: Buffer): string;
}

let safeStorageProbed = false;
let cachedSafeStorage: SafeStorage | null = null;

/**
 * Try to reach Electron's `safeStorage` from the plugin (renderer) process.
 * It is officially a main-process API, so depending on the Obsidian/Electron
 * build it may be exposed directly, via the legacy `remote`, or via
 * `@electron/remote`. We try each and verify encryption is actually available.
 */
function getSafeStorage(): SafeStorage | null {
	if (safeStorageProbed) return cachedSafeStorage;
	safeStorageProbed = true;

	const candidates: Array<() => unknown> = [
		() => (require("electron") as { safeStorage?: unknown }).safeStorage,
		() => (require("electron") as { remote?: { safeStorage?: unknown } }).remote?.safeStorage,
		() => (require("@electron/remote") as { safeStorage?: unknown }).safeStorage,
	];

	for (const get of candidates) {
		try {
			const ss = get() as SafeStorage | undefined;
			if (ss && typeof ss.isEncryptionAvailable === "function" && ss.isEncryptionAvailable()) {
				cachedSafeStorage = ss;
				console.info("[sts-llm-wiki] secrets: encrypting with OS keychain (Electron safeStorage)");
				return ss;
			}
		} catch {
			/* try next access path */
		}
	}

	console.info("[sts-llm-wiki] secrets: safeStorage unavailable — storing plaintext outside the vault");
	cachedSafeStorage = null;
	return null;
}

export function secretsPath(): string {
	return FILE;
}

export function loadSecrets(): Secrets {
	try {
		if (!fs.existsSync(FILE)) return {};
		const raw = fs.readFileSync(FILE, "utf8");
		const parsed = JSON.parse(raw) as Secrets | { enc: string };
		// Encrypted form: { enc: "<base64 of safeStorage.encryptString>" }.
		if (parsed && typeof (parsed as { enc?: unknown }).enc === "string") {
			const ss = getSafeStorage();
			if (!ss) {
				console.error("[sts-llm-wiki] credentials are encrypted but safeStorage is unavailable to decrypt");
				return {};
			}
			const buf = Buffer.from((parsed as { enc: string }).enc, "base64");
			return JSON.parse(ss.decryptString(buf)) as Secrets;
		}
		return parsed as Secrets;
	} catch (err) {
		console.error("[sts-llm-wiki] failed to read credentials:", err);
	}
	return {};
}

export function saveSecrets(s: Secrets): void {
	try {
		fs.mkdirSync(DIR, { recursive: true });
		const json = JSON.stringify(s);
		const ss = getSafeStorage();
		const payload = ss
			? JSON.stringify({ enc: ss.encryptString(json).toString("base64") }, null, 2) + "\n"
			: JSON.stringify(s, null, 2) + "\n";
		fs.writeFileSync(FILE, payload, "utf8");
		try {
			fs.chmodSync(FILE, 0o600); // best-effort; no-op on Windows
		} catch {
			/* ignore */
		}
	} catch (err) {
		console.error("[sts-llm-wiki] failed to write credentials:", err);
	}
}
