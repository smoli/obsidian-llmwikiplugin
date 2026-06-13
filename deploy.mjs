// Deploy the built plugin into an Obsidian vault.
//
// Usage:
//   npm run deploy -- <path-to-vault>            (builds, then copies)
//   npm run deploy -- <path-to-vault> --no-build (copies the existing build)
//
// Copies main.js, manifest.json and styles.css into
//   <vault>/.obsidian/plugins/<plugin-id>/

import { execSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";

const args = process.argv.slice(2);
const skipBuild = args.includes("--no-build");
const vaultArg = args.find((a) => !a.startsWith("--"));

if (!vaultArg) {
	console.error('Usage: npm run deploy -- "<path-to-vault>" [--no-build]');
	process.exit(1);
}

const vault = resolve(vaultArg);
const obsidianDir = join(vault, ".obsidian");
if (!existsSync(obsidianDir)) {
	console.error(`Not an Obsidian vault (no .obsidian folder found): ${vault}`);
	process.exit(1);
}

if (!skipBuild) {
	console.log("Building…");
	execSync("npm run build", { stdio: "inherit" });
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const dest = join(obsidianDir, "plugins", manifest.id);
mkdirSync(dest, { recursive: true });

const files = ["main.js", "manifest.json", "styles.css"];
for (const f of files) {
	if (!existsSync(f)) {
		console.error(`Missing ${f} — run the build first (omit --no-build).`);
		process.exit(1);
	}
	copyFileSync(f, join(dest, f));
}

console.log(`Deployed ${manifest.id} v${manifest.version} → ${dest}`);
