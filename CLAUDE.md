# snarky-task

A local, LLM-assisted task manager built on the xweb shell. You type a plain-text instruction; a card exists, or gets updated, or gets the right status — and every decision the model made is visible as a file you can edit. Three layers: data in `workspace/tasks/`, two dumb surfaces at `127.0.0.1:7920/feed` and `/board`, and capabilities bound by name in `workspace/tasks/config.json`. Swap a capability by editing that file. If a bound capability fails, the instruction parks in `attention` with the real error. Nothing silently degrades.

## Data layout

```
workspace/tasks/
  config.json        # capability bindings + thresholds (see below)
  registry.json      # actions the engine can take
  queue/             # one .md file per instruction
  cards/             # one .md file per task card
  artifacts/         # delegation outputs (generator / agent)
```

Files are the state. Every input path (type in the feed, POST to the API, MCP `task` tool, hand-edit) ends as a write here. The watcher reconciles. Hand edits are first-class.

## Surfaces

Both surfaces are served from the same HTTP server at `127.0.0.1:7920`. All fonts vendored locally; fully offline.

- **`/feed`** — input line at bottom; rows above show instruction status (working, needs_confirmation, attention, done). `#` autocompletes card shortnames. Click a row for detail, edit-and-requeue, or delete.
- **`/board`** — three zones: surface (active masonry + backlog rail on right = inbox/waiting), columns (5-column kanban), list (dense Linear-ish rows). Mode via `1/2/3` keys. Archive view (`⇧A`) grouped by completion date. Fully keyboard-driven: `↑↓←→` move focus, `⏎` grow-in-place edit (no modals), `e` edit title, `a/b/d/x` zone moves (via queue), `⌘⏎` save, `esc` shrink. Cards: notes (title only, paper-flat) promote to posts (floating, description + meta) on content arrival. `urgent`/`important` labels render gradient (pink→orange→yellow, rotation per card). Active card bottom edge: accent gradient. Feed shows `›_` for every keyboard mutation.

Surfaces hold no state beyond the DOM. They render SSE snapshots from `/api/events` and POST actions back.

### CLI Layer

Type bare verbs (`create|new`, `move|mv`, `note|log`, `link`, `delete|del|rm`, `delegate`) to act on tasks. Sigils augment: `#tag/#ref` names a card, `$status/$date` sets state, `@collaborator` routes to an executor. Prefix with `/` to force command mode (fails loud on parse). Recognized commands that fail their grammar park loud; input with no verb is **captured as a card** (absence of command means create). A claimed verb with a fuzzy card ref gets exactly one model question — which card — shown as `via: cli+ai` (`›_✦`). See `docs/specs/2026-10-06-slot-resolution-design.md`.

## Capabilities (`workspace/tasks/config.json`)

```json
{
  "resolver":  { "impl": "ollama", "host": "http://127.0.0.1:11434", "model": "qwen3:4b" },
  "dates":     { "impl": "chrono" },
  "generator": { "impl": "ollama", "host": "http://127.0.0.1:11434", "model": "qwen3:4b" },
  "agent":     { "impl": "claude-cli", "enabled": true },
  "collaborators": { "claude": { "use": "agent" }, "local": { "use": "generator" } },
  "thresholds": { "card": 0.6 },
  "jobs": { "max_parallel": 3 },
  "confirmation_timeout_s": 300
}
```

To use Laya as the resolver instead of Ollama, flip `resolver.impl` to `"laya"` and set `resolver.checkpoint` to the bundle directory. See `docs/laya.md` for the real Laya API (`Laya.load({ modelDir })` / `systemOne()`), download instructions, and a manual verification snippet.

**No-fallbacks rule.** Every capability is bound by name. A binding that fails to load throws at startup (shown in the feed). A binding that fails at runtime sends that instruction to `attention` with the real error. There is no silent degradation.

## MCP tools

Tools are registered via `workspace/.mcp.json` (points at the same `127.0.0.1:7920` server).

- **`task`** — `task(instruction)` → `POST /api/instructions`. Same door as feed input.
- **`screenshot`** — capture the current browser view.

Do NOT run `/x` commands via Bash. Call the MCP tools directly.

## Dev commands

```bash
npm run dev          # start electron-vite dev server
npm run build        # typecheck + build
npm run typecheck    # typecheck only
npx vitest run       # run tests
```

## Environment variables

| Variable | Effect |
|---|---|
| `XWEB_WORKSPACE` | Path to the workspace directory (default: `./workspace`) |
| `XWEB_MCP_PORT` | MCP / HTTP server port (default `7920`); update `workspace/.mcp.json` to match |

## Architecture

- `src/main/` — Electron main process: HTTP+MCP server, engine, file watcher, IPC
- `src/main/capabilities/` — capability implementations (laya-resolver, ollama-resolver, chrono-dates, ollama-generator, claude-agent)
- `src/main/engine/` — pipeline: pre-pass → cli → resolve → gate → handle → delegate
- `src/renderer/` — minimal React sliver (divider + bounds reporting for the two WebContentsViews)
- `src/shared/` — shared types (`Instruction`, `Card`, `Snapshot`, `Registry`, `TaskdeckConfig`)
- `workspace/` — live data (tasks/, .mcp.json); this directory is the workspace
