# Pi Agent for Obsidian

Chat with the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
in a side panel inside Obsidian. Pi runs scoped to your vault, reads the vault's
`AGENTS.md`, and can **read, create, and edit your wiki pages** — driven by the
LLM of your choice.

This was built for an LLM-wiki vault (Karpathy-style): a `raw/` → `summaries/` →
`wiki/` knowledge base whose conventions live in `AGENTS.md` at the vault root.

## How it works

The plugin spawns `pi --mode rpc` as a background process with its working
directory set to your vault root (or a configured subfolder). Because pi
discovers `AGENTS.md` by walking up from its working directory, it automatically
picks up your wiki's rules, and its built-in `read` / `write` / `edit` / `bash`
tools operate directly on the vault's files.

Communication uses pi's JSON-over-stdio RPC protocol. The panel streams the
agent's text, shows each tool call (collapsible), and surfaces provider errors.

```
Obsidian panel  ⇄  pi --mode rpc  (cwd = vault root)  ⇄  your chosen LLM
                          │
                          ├─ reads AGENTS.md automatically
                          └─ read/write/edit tools act on wiki pages
```

## Requirements

- **pi** installed and on your `PATH`:
  ```
  npm install -g @earendil-works/pi-coding-agent
  ```
  (verify with `pi --version`). If it is not on `PATH`, set the full path to
  `pi` / `pi.cmd` in the plugin settings.
- At least one provider configured for pi (API key or login). Run `pi` once in a
  terminal to set up credentials; they live in `~/.pi/agent/auth.json`.
- Desktop Obsidian (the plugin needs Node child-process access; it is marked
  `isDesktopOnly`).

## Usage

1. Open the panel via the ribbon **bot** icon or the command
   *"Open Pi Agent panel"*.
2. Pick your model and thinking level in the panel header.
3. Ask away. Pi can answer questions about the wiki and make edits, e.g.
   *"Ingest the new PDF in raw/ and update the wiki per AGENTS.md."*

Header controls:

- **Model dropdown** — switch the LLM live (any provider pi has credentials for).
- **Thinking dropdown** — reasoning effort.
- **+** — start a fresh session.
- **■** — stop the current run. Sending while pi is running *steers* it.

## Settings

| Setting | Description |
|---|---|
| Pi command | Command/path used to launch pi (default `pi`). |
| Working directory | Folder pi runs in, relative to the vault root. Empty = vault root (where `AGENTS.md` is). |
| Default provider / model | Passed to pi at startup. You can also switch live. |
| Thinking level | Reasoning effort. |
| Persist sessions | Save conversations to pi's session store so they can be resumed. |
| Show thinking | Display the agent's reasoning blocks. |
| Tool permission dialogs | Ask / always allow / always block confirmation prompts pi raises. |

## Development

```
npm install
npm run dev      # watch build → main.js
npm run build    # type-check + production bundle
```

To test the raw RPC integration without Obsidian:

```
node scripts/rpc-smoke.mjs "C:\path\to\your\vault"
```

Deploy by copying `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/pi-agent/`, then enable the plugin.

## Notes & troubleshooting

- **"Third-party apps now draw from your extra usage…"** or other provider
  errors appear as a red block in the chat. These come from your LLM provider,
  not the plugin — switch models or top up usage as the message indicates.
- pi's `bash` tool can run shell commands in your vault. Use the *Tool permission
  dialogs* setting to gate them.
- The plugin operates on real files in your vault. Since the target vault is a
  git repo and `AGENTS.md` asks pi to commit, your history is your safety net.
