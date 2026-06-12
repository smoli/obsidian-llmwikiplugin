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
  `AGENTS.md` is fed to it (Claude Code natively reads `CLAUDE.md`, so this is how
  it learns the wiki rules) — by default appended to Claude's own prompt so its
  built-in working-directory grounding is preserved, or optionally replacing it
  (see *AGENTS.md handling* in settings). Permission behavior is configurable too.

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

### Git actions

If your vault is a git repository, a **git** button (branch icon) appears in the
header with:

- **Commit all changes…** — stages everything, then opens a commit dialog. By
  default it's **pre-filled with a suggested message** that the selected engine
  generates from the staged diff, following your AGENTS.md's commit format and
  language (e.g. it writes the message in German if AGENTS.md asks for German) —
  edit or accept it. Turn this off under *Settings → Git → Suggest commit
  messages* for an empty dialog. Does nothing if there's nothing to commit.
- **Commit & push…** — the above, then `git push`.
- **Push** — `git push`.

Useful when you made a quick change via chat that's too fine-grained for the
agent to commit each time, or to push when you're ready. Git runs directly in the
vault (credential prompts are disabled, so a push needing fresh credentials fails
fast with a notice rather than hanging).

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

## Saving a chat

The **save** button (disk icon) in the header writes the current conversation to
a Markdown file in your vault. Only **user messages and assistant text** are
saved — tool/bash calls are omitted, so it reads as a clean transcript you can
copy from or keep.

Clicking save again on the **same conversation updates the same file** (it
doesn't pile up duplicates); the file is created on the first save and overwritten
on later ones, keeping its original name and date/time. Starting a new session
(or switching engine/persona) begins a fresh chat that saves to a new file. If you
move or delete the saved file, the next save creates a new one.

The target folder is set under **Settings → Chats → Chat save folder** (default
`Chats`, empty = vault root). Each file gets frontmatter with the engine, model,
persona, date and time:

```markdown
---
date: 2026-06-12
time: 14:30
engine: claude
model: "Opus"
persona: "Sparringspartner"
---

## You

…

## Assistant

…
```

You can also select text directly in the panel and copy it (text selection is
enabled in the chat).

## Personas

By default the agent uses your vault's `AGENTS.md` as its system prompt.
**Personas** let you swap in a different system prompt per session for more
specific work (a reviewer, a brainstorming sparring partner, a translator, …).

Create a markdown file **in the vault root** with `PERSONA: true` in its
frontmatter:

```markdown
---
PERSONA: true
name: Sparringspartner
---

You are a critical sounding board. Question assumptions, offer counter-arguments…
```

A **persona dropdown** then appears in the panel header (it's hidden when no
personas exist). Pick one and the session restarts using that persona's content
(frontmatter stripped) as the system prompt **instead of AGENTS.md** — the agent
still has full vault access. Pick *Default (AGENTS.md)* to go back. Your choice is
remembered. `name:` (or `title:`) sets the display label; otherwise the file name
is used.

> For Claude Code the persona replaces the AGENTS.md prompt while keeping Claude's
> built-in working-directory grounding. For pi the persona is appended to its
> prompt (pi still auto-loads AGENTS.md from the vault root).

## Clickable options

When the agent asks you to pick one of several choices — a message ending in a
question with a numbered list — the list items render as **clickable option
chips** (numbered, visually distinct from wiki links). Click one to send it as
your reply instead of typing it; the rest dim out. Paths inside options are shown
as plain text, not links, so picking an option never gets confused with opening a
page.

## Ask about a selection

Right-click in a note (edit / live-preview mode):

- **With text selected** → **"Ask <engine> about selection"** — attaches the
  selection *and* its page.
- **With nothing selected** → **"Ask <engine> about this page"** — attaches just
  the page reference, so you can ask about the whole page.

(The label reflects your selected engine — "Ask pi…" or "Ask Claude Code…"; also
available as the command *Ask the agent about selection or page*.) This opens a
fresh chat session and attaches the context as a read-only **chip above the
input** (click the path to open the page, or the × to remove it). Type your
question in the clean input box; the attached context is prepended to your
message when you send, then the chip clears. The agent still has full vault access, so it can pull in
anything else it needs to answer.

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
