# Milestone: Direct OpenAI backend

Talk to the **OpenAI API directly** as a third engine, alongside pi and Claude
Code. Unlike those two, the OpenAI API is *not* an agent — it's an LLM endpoint —
so this backend has to **be the agent**: run the tool-calling loop and execute
file tools against the vault ourselves.

This document is the living plan; statuses are kept current as work proceeds.

## Guiding constraint: YOLO, vault-confined

The first version runs in **YOLO mode** — tools execute automatically, no
permission prompts — but **every operation is hard-confined to the vault working
directory**. The path sandbox is the safety boundary that makes YOLO acceptable,
so it is non-negotiable from Phase 2 on (not a later add-on). Permission prompts
(gating writes/bash via the existing `dialogPolicy`) come later, as an opt-in.

## Why this is bigger than another CLI adapter

`PiBackend` / `ClaudeBackend` are thin adapters over agents that already own the
loop + tools. The OpenAI endpoint owns neither, so we build:

- the **streaming HTTP** client,
- the **agent loop** (model → tool calls → we execute → feed back → repeat),
- the **tools** (read/write/edit/list/grep, later commit) executed on the vault,
- the **conversation state** (resume).

## What stays the same

The `AgentBackend` seam means the rest of the plugin is untouched. We add one
class `OpenAiBackend implements AgentBackend` that emits the existing
`BackendEvent` stream (`run-start`, `text-delta`, `tool-start/update/end`,
`thinking-delta`, `run-end`, `stats`, `error`), plus an `"openai"` engine option
in settings and `connect()` / `SessionRuntime.start()`. The view, runtimes,
sidebar, sessions and resume all work as-is.

## API choice

Use the **Responses API** (`/v1/responses`):

- SSE **streaming** → map deltas to our events.
- **Function/tool calls** with streamed arguments.
- **Server-side state** via `store: true` + `previous_response_id` → maps cleanly
  to `getEngineSessionId()` / resume.
- **Reasoning** summaries (GPT-5 / o-series) → `thinking-delta`.
- `usage` in the final event → `stats`.

Stream-event → BackendEvent mapping:
`response.output_text.delta` → `text-delta`;
`response.reasoning_summary.delta` → `thinking-delta`;
`response.function_call_arguments.delta` → `tool-start`/`tool-update`;
`response.completed` (usage) → `run-end` + `stats`.

## The path sandbox (cross-cutting)

Every tool resolves its path **relative to the working dir** and rejects anything
that escapes it: reject absolute paths outside the vault, reject `..` traversal,
resolve symlinks and re-check, normalize separators. A single `resolveInVault()`
helper all tools go through. Bash (Phase 4) is the hardest to confine — treated
separately.

## Phases

### Phase 0 — Plan ✅ (this doc)

### Phase 1 — Plumbing: streaming text, no tools ✅ DONE

Prove the end-to-end pipe: pick OpenAI in the header, type, stream a reply. No
file access yet (just talking to the model).

- [x] Settings: `openaiApiKey` (password field), `openaiBaseUrl`, `openaiModel` +
      an "OpenAI" settings section. Plaintext-`data.json` caveat noted in the UI.
- [x] `OpenAiBackend extends BaseBackend`: `start`, `prompt`, `abort` (destroys the
      request), `dispose`, `running`. Streams via Node `https` (avoids renderer
      CORS; `requestUrl` can't stream).
- [x] Responses API `POST /responses` with `stream: true`, SSE parsing; text
      deltas → `text-delta`, completion → `run-end` + `stats` (usage tokens).
- [x] Engine option `"openai"` in the settings + header dropdown, `engineLabel()`,
      `SessionRuntime.start()` branch. Engine type widened everywhere.
- [x] System prompt = our assembled persona/AGENTS.md file (`instructions`), reusing
      `resolvePersonaPromptFile` / `resolveAgentsPromptFile`.
- [x] Resume: `previousResponseId` ↔ `engineSessionId`; `store: true` +
      `previous_response_id`.
- [x] `getModels()` returns the configured model; `getStats()` from usage. Build
      green, deployed.

Not yet: `/v1/models` listing, cost, reasoning→thinking (Phase 5). Untested against
a live key — needs the user's `openaiApiKey`.

### Phase 2 — Read-only tools + agent loop (YOLO, sandboxed) ✅ DONE

- [x] `resolveInVault()` path sandbox helper (lexical `..`/absolute reject +
      symlink realpath re-check) in `src/openai-tools.ts`.
- [x] Tools: `read_file` (line-numbered, offset/limit), `list_dir`, `grep`
      (regex walk, skips .git/.obsidian/node_modules, capped) as function schemas
      (Responses flat `{type:"function", …}` shape).
- [x] Agent loop in `OpenAiBackend.prompt`: `runTurn()` streams a turn and
      collects function calls + raw output items; execute each, append
      `function_call_output`, repeat until a text-only answer (cap 25 iters).
      Auto-execute (YOLO). API-key mode rides `previous_response_id`; subscription
      mode replays the full item list (`this.items`, incl. model output +
      reasoning + tool outputs).
- [x] Tool execution → `tool-start` (on args.done, parsed args) / `tool-end`
      (result or error) so the existing tool blocks + "calling …" busy label work.
- [x] Now it can answer questions grounded in the wiki. Build green, deployed.

Not yet: tests for `resolveInVault`; parallel tool calls run sequentially.

### Phase 3 — Mutating tools (YOLO, sandboxed) ⬜ TODO

- [ ] `write_file`, `edit_file` (string-replace), `mkdir` — all via the sandbox.
- [ ] Can run the ingest workflow end-to-end (create/update wiki pages).

### Phase 4 — Commit step ⬜ TODO

- [ ] A constrained `git_commit` tool (stage + commit in the vault) — or a
      narrowly-scoped `bash`. Bash sandboxing is the risky part; prefer a
      dedicated git tool first.
- [ ] Full AGENTS.md workflow incl. the closing commit.

### Phase 5 — Hardening ⬜ TODO

- [ ] Mid-stream abort wired through `abort()`.
- [ ] Error / rate-limit / retry handling; surface as `error` events.
- [ ] Parallel tool calls.
- [ ] Reasoning → `thinking-delta`; `capabilities.thinking` for reasoning models.
- [ ] Cost in `stats` (usage × model price).
- [ ] Live model switching (`setModel`) + dropdown.

### Phase 6 — Beyond YOLO (future, opt-in) ⬜ TODO

- [ ] Gate writes / bash through the existing permission flow (`dialogPolicy`,
      `respondPermission`) — same UI Claude uses.
- [ ] Better secret storage than plaintext `data.json` (or env-var preference).

## Sharp edges

- **Secrets:** we hold the API key; `data.json` is plaintext in the vault config.
  Flag it; consider env-var support.
- **Path escapes:** the whole safety story. Absolute paths, `..`, symlinks.
- **Bash confinement:** can't be fully sandboxed by cwd alone — defer / prefer a
  git-only tool.
- **Tool-call streaming & parallelism:** arguments arrive in deltas; multiple
  calls per turn.
- **Rich history for resume fallback:** if not using server-side state, we must
  keep the full message list incl. tool calls/results (richer than
  `session.transcript`'s display text).

## Auth modes

Two ways to authenticate (settings → OpenAI → Authentication):

1. **API key** — `Authorization: Bearer sk-…`, hits `/{baseUrl}/responses` with
   `store: true` + `previous_response_id` (server-side resume).
2. **ChatGPT subscription** — the **Codex "Sign in with ChatGPT" OAuth** flow,
   reverse-engineered from pi's open source (`@earendil-works/pi-ai`). It's a real
   native OpenAI login (we were wrong that none existed):
   - OAuth PKCE against `https://auth.openai.com` (`/oauth/authorize` + `/oauth/token`),
     client_id `app_EMoamEEZ73f0CkXaXp7hrann`, redirect `http://localhost:1455/auth/callback`,
     scope `openid profile email offline_access`. Implemented in `src/openai-oauth.ts`.
   - account id from the access-token JWT claim `https://api.openai.com/auth`.
   - model calls go to `https://chatgpt.com/backend-api/codex/responses` with
     headers `Authorization`, `chatgpt-account-id`, `originator: pi`,
     `OpenAI-Beta: responses=experimental`. **`store: false` is required**, so we
     replay the full message history each turn (seeded from `session.transcript`).
   - token refreshed on 401 via the refresh_token.
   - **Gray area:** uses OpenAI's first-party Codex client id + undocumented
     endpoint; can break without notice. Requires a ChatGPT plan with Codex.

## Decisions / open questions

- Raw API (full control, this plan) vs. driving an OpenAI agent CLI (thin adapter
  like pi/Claude). Chosen: **raw API**.
- Default model? (a current GPT-5-tier model.)
- Tool surface: dedicated `git_commit` vs. generic `bash`. Leaning dedicated.
- Subscription mode has **no server-side resume** (`store:false`); we replay
  history. Fine for text; with tools (Phase 2+) we must replay the rich history
  (tool calls/results), not just display text.

## Changelog

- _init_ — plan written; YOLO-in-vault as the guiding constraint. Next: Phase 1.
- **Phase 1 done** — `src/openai-backend.ts` (`OpenAiBackend`) streams the
  Responses API via Node `https`; engine `"openai"` wired through settings, header
  dropdown, `engineLabel`, `SessionRuntime.start`. Resume via `previous_response_id`.
  Build green, deployed on branch `native-openai`. Text-only — no tools yet.
- **Subscription login added** — `src/openai-oauth.ts` implements the Codex
  ChatGPT OAuth (PKCE, localhost:1455 callback, refresh); `OpenAiBackend` gained a
  subscription auth mode (Codex backend endpoint, `store:false`, full-history
  replay, 401→refresh). Settings: auth-mode dropdown + "Sign in with ChatGPT"
  button; plugin `loginOpenAi`/`logoutOpenAi`/`refreshOpenAiToken`. Build green,
  deployed. **Untested against a live ChatGPT login.**
- **Phase 2 done** — read-only tool loop. `src/openai-tools.ts` adds the
  `resolveInVault` sandbox + `read_file`/`list_dir`/`grep`. `OpenAiBackend` now
  runs the agent loop (`runTurn` → execute calls → feed `function_call_output`
  back → repeat), YOLO but vault-confined; tools include schemas in the request
  and map to `tool-start`/`tool-end`. Both auth modes handle tool calls (apikey
  via `previous_response_id`, subscription via full item replay). Deployed.
- **Secret storage upgraded (keychain)** — `src/secrets.ts` now encrypts the
  out-of-vault `~/.sts-llm-wiki/credentials.json` with Electron `safeStorage` (OS
  keychain: Windows DPAPI / macOS Keychain / Linux libsecret) when reachable, with
  a plaintext fallback so login never breaks. Feature-detects across
  `electron.safeStorage` / `electron.remote` / `@electron/remote` (latter external
  in esbuild); logs which path engaged. Addresses Phase 6's "better secret storage
  than plaintext data.json" ahead of schedule. The earlier git-leak fix (secrets
  out of the tracked vault `data.json`) stays in place.
