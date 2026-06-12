# Pi Agent for Obsidian

Chat with the [pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
in a side panel inside Obsidian. Pi runs scoped to your vault, reads the vault's
`AGENTS.md`, and can **read, create, and edit your wiki pages** — driven by the
LLM of your choice.

This was built for an LLM-wiki vault (Karpathy-style): a `raw/` → `summaries/` →
`wiki/` knowledge base whose conventions live in `AGENTS.md` at the vault root.

## How it works

The plugin drives an **agent engine** as a background process whose working
directory is your vault root (or a configured subfolder), so its file tools
operate directly on the vault and it picks up your `AGENTS.md`. You choose the
engine in the panel header (or settings):

- **pi** — spawned as `pi --mode rpc`. Discovers `AGENTS.md` automatically; lists
  and switches across every model pi has credentials for (67+); supports a
  thinking-level control.
- **Claude Code** — spawned as `claude --print --input-format stream-json
  --output-format stream-json --include-partial-messages`. Your vault's
  `AGENTS.md` is passed via `--system-prompt-file` (Claude Code natively reads
  `CLAUDE.md`, so this is how it learns the wiki rules). Permission behavior is
  configurable (see below).

Both engines are adapted to one normalized event stream, so the panel — streaming
text, collapsible tool calls, clickable page links, quick prompts, error
surfacing — works identically regardless of engine.

```
Obsidian panel  ⇄  AgentBackend  ⇄  pi --mode rpc            ⇄  your chosen LLM
                                 ⇄  claude --print (stream-json) ⇄  Claude
                          │
                          ├─ runs in the vault root (sees AGENTS.md)
                          └─ read/write/edit tools act on wiki pages
```

## Requirements

- Desktop Obsidian (the plugin needs Node child-process access; it is marked
  `isDesktopOnly`).
- For the **pi** engine: pi installed and on your `PATH`
  (`npm install -g @earendil-works/pi-coding-agent`; verify with `pi --version`),
  plus at least one provider configured (run `pi` once to set up credentials in
  `~/.pi/agent/auth.json`). If pi isn't on `PATH`, set the full path in settings.
- For the **Claude Code** engine: the Claude Code CLI installed
  (verify with `claude --version`). If `claude` isn't on Obsidian's `PATH`, set
  the full path in settings (on Windows it is typically
  `C:\Users\<you>\.local\bin\claude.exe`). Uses your existing Claude Code login.

You only need the engine(s) you intend to use.

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

### Standard prompts (one-click buttons)

The bar above the input holds reusable prompts you can fire with a single click
(e.g. *Lint wiki*, *Ingest raw/*, *Refresh index*). They are stored as JSON in a
file at your **vault root** — `pi-agent-prompts.json` by default:

```json
{
  "prompts": [
    { "id": "lint", "label": "Lint wiki", "prompt": "Lint and audit the wiki…" }
  ]
}
```

Manage them two ways, both backed by the same file:

- **Settings → Pi Agent → Standard prompts** — add, edit the label/text, delete,
  and save.
- **Edit the JSON file directly** in the vault — the panel buttons reload
  automatically when the file changes.

Clicking a button sends its prompt immediately (and *steers* pi if it's already
running). The file name is configurable in settings.

## Ask about a selection

Select text in any note (edit / live-preview mode), right-click, and choose
**"Ask <engine> about selection"** (the label reflects your selected engine —
"Ask pi…" or "Ask Claude Code…"; also available as the command *Ask the agent
about selection*). This opens a fresh chat session seeded with the selected text
and the page it came from, and leaves the cursor in the input so you can type
your question. The agent still has full vault access, so it can pull in anything
else it needs to answer.

## Automation: run on new file

The plugin can watch a folder and automatically run a prompt whenever a new file
lands in it — e.g. drop a PDF into your raw folder and have the agent ingest it.

Enable it under **Settings → Pi Agent → Automation**:

- **Run on new file in folder** — master toggle (off by default).
- **Watch folder** — vault-relative folder to watch (default `99-raw`).
- **Prompt** — what to send. `{{files}}` expands to the list of new files and
  `{{count}}` to how many.

When files are added, the panel opens (if needed), connects, and runs the prompt.
Multiple files dropped together are debounced into a single run. Files already in
the vault at startup do **not** trigger it — only genuinely new ones.

## Settings

| Setting | Description |
|---|---|
| Engine | Which agent to run: **pi** or **Claude Code**. Also switchable from the panel header. |
| Pi command | Command/path used to launch pi (default `pi`). |
| Working directory | Folder pi runs in, relative to the vault root. Empty = vault root (where `AGENTS.md` is). |
| Default provider / model | Passed to pi at startup. You can also switch live. |
| Thinking level | Reasoning effort. |
| Persist sessions | Save conversations to pi's session store so they can be resumed. |
| Show thinking | Display the agent's reasoning blocks. |
| Tool permission dialogs | Ask / always allow / always block confirmation prompts pi raises (and Claude's permission asks). |
| Prompts file | Vault-root JSON file holding the one-click standard prompts. |
| Run on new file / Watch folder / Prompt | Auto-run a prompt when files appear in a watched folder (see Automation above). |
| Claude command | Command/path to the Claude Code CLI (default `claude`). |
| Claude model | `default` / Opus / Sonnet / Haiku. |
| Permissions (Claude) | **Bypass all** (edits + bash/git, no prompts — needed for the full wiki workflow), **Auto-accept edits only** (edits auto-approved, bash restricted), or **Ask me per tool** (prompts in the panel). |

> **Claude permissions:** the AGENTS.md wiki workflow ends with a `git commit`,
> which is a bash action. "Auto-accept edits only" will *not* run it — use
> "Bypass all" (the default) for the complete workflow, or "Ask me per tool" to
> approve each step. The plugin runs Claude scoped to your vault's working
> directory; your vault being a git repo is your safety net.

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
