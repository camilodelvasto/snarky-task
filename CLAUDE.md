# snarky-task

A local, LLM-assisted task manager built on the xweb shell. You type a plain-text instruction; a card exists, or gets updated, or gets the right status — and every decision the model made is visible as a file you can edit. Three layers: data in `workspace/projects/<name>/tasks/`, two dumb surfaces at `127.0.0.1:7920/feed` and `/board`, and capabilities bound by name in each project's `config.json`. Swap a capability by editing that file. If a bound capability fails, the instruction parks in `attention` with the real error. Nothing silently degrades.

## Data layout

```
workspace/
  current                     # ONE LINE: active project name — the switch IS a file
  projects/
    default/tasks/            # config.json, registry.json, queue/ cards/ history/ artifacts/
    house-renovation/tasks/
  templates/
    default/                  # config.json + registry.json — fresh-clone scaffold (tracked)
    gtd/cards/*.md            # seed decks: plain card files (tracked)
    renovation/cards/*.md
    business-canvas/cards/*.md
  .mcp.json
```

Files are the state. Every input path (type in the feed, POST to the API, MCP `task` tool, hand-edit) ends as a write here. The watcher reconciles. Hand edits are first-class. Cards and instructions carry a `v:` schema version and are validated against bundled JSON Schemas (`src/main/tasks/schema/`) at read and write. The `/check` meta command validates the whole workspace, ensuring every card and instruction conforms to its schema version. See `docs/specs/2026-10-20-content-schema-validation-design.md`.

- Each project owns its full `tasks/` set, including `config.json` and `registry.json` — a canvas project can have different collaborators or thresholds than the default one.
- **Migration (one-time, at boot):** if `workspace/tasks` exists and `workspace/projects` does not, it moves to `workspace/projects/default/tasks` and `current` is written. Hand-rollable backwards by moving it back.
- **Fresh-clone bootstrap:** if neither `tasks/` nor `projects/` exists but `templates/default/` does, `projects/default/tasks` is scaffolded from the template and `current` is written. No manual setup required after `git clone`.
- `workspace/templates/` is tracked in git; live project data (`projects/`, `current`, `.trash/`) is gitignored.

## Projects

Manage projects from the console (`project` is a command, not a card action):

| input | effect |
|---|---|
| `project` or `projects` | list projects into the feed (active one marked) |
| `project <name>` | switch: write `workspace/current`, engine rebinds |
| `project new <name>` | create from the default scaffold (empty deck) |
| `project new <name> from <t>` | create seeded from `workspace/templates/<t>/` |
| `project rm <name>` | confirmation gate; then the project dir moves to `workspace/.trash/<timestamp>-<name>/` — never deleted, always greppable. Removing the active project switches to `default` first; `default` itself is not removable. |

Switching = writing `workspace/current`. A watcher on that file makes hand edits and `git pull`s first-class switches. The board topbar shows the active project name; clicking it drops the list.

A template is a directory of card `.md` files plus optional `config.json` / `registry.json` overrides. Ship three starters: `gtd`, `renovation`, `business-canvas`. Authoring a template = copying a project you like into `workspace/templates/<name>/` and pruning.

## Working-directory resolution

The workspace root is resolved in this order:

1. `XWEB_WORKSPACE` env var when set
2. First line of `~/.config/snarky-task/root` when it names an existing directory (trimmed, `~` expanded; stale pointer warns and falls through) — point it at a Syncthing or git-synced folder to move your data off-repo
3. `./workspace` relative to the app root

**Synced workspaces (two machines, one folder).** Each machine has a device id in `~/.config/snarky-task/device` (written once on first boot, never synced). Instructions carry `device:` in frontmatter: the first engine to see an unowned instruction stamps it; only the owner runs, crash-recovers, or TTL-sweeps it. Another device's rows show in the feed; requeueing one takes ownership. A synced card change that arrives with log lines this engine hasn't seen was logged at the source and is absorbed, not re-logged as `(direct edit)`. Upgrade and boot once on the existing machine before sharing the folder so legacy instructions are claimed there.

## Surfaces

Both surfaces are served from the same HTTP server at `127.0.0.1:7920`. All fonts vendored locally; fully offline.

- **`/feed`** — input line at bottom; rows above show instruction status (working, needs_confirmation, attention, done). `#` autocompletes card shortnames. Click a row for detail, edit-and-requeue, or delete.
- **`/board`** — three zones: surface (active masonry + backlog rail on right = inbox/waiting), columns (5-column kanban), list (dense Linear-ish rows). Mode via `1/2/3` keys. Archive view (`⇧A`) grouped by completion date. Fully keyboard-driven: `↑↓←→` move focus, `⏎` grow-in-place edit (no modals), `e` edit title, `a/b/d/x` zone moves (via queue), `⌘⏎` save, `esc` shrink. Cards: notes (title only, paper-flat) promote to posts (floating, description + meta) on content arrival. `urgent`/`important` labels render gradient (pink→orange→yellow, rotation per card). Active card bottom edge: accent gradient. Feed shows `›_` for every keyboard mutation.

Surfaces hold no state beyond the DOM. They render SSE snapshots from `/api/events` and POST actions back.

### CLI Layer

Type bare verbs (`create|new`, `move|mv`, `note|log`, `link`, `delete|del|rm`, `delegate`) to act on tasks. Sigils augment: `#tag/#ref` names a card, `$status/$date` sets state, `@collaborator` routes to an executor, `^scope` sets how much context a delegation carries (`^card` default = title + description; `^full` adds the card's activity log and prior outputs; `^board` adds a one-line roster of the project's other live cards). A collaborator may carry its own default `scope` in `config.json`; the inline `^` sigil overrides it. Prefix with `/` to force command mode (fails loud on parse).

**Privacy.** A card labeled `private` (name set by `ui.private_label`) is never sent to an external agent: delegating it to a collaborator whose `use` is `agent` (claude-cli) parks the instruction in `attention`, and private cards are omitted from any `^board` roster. The on-device `generator` (Ollama) is still allowed — it never leaves the machine. The label renders as a slate (`--private`) toggle/edge on the board. Recognized commands that fail their grammar park loud; **input with no recognized command also parks loud** — it is NOT silently filed as a card (a typo'd command or stray line should never become a card). To capture a thought as a card, prefix the line with `+` (`+ call the plumber #urgent` → a card). A claimed verb with a fuzzy card ref gets exactly one model question — which card — shown as `via: cli+ai` (`›_✦`). See `docs/specs/2026-10-06-slot-resolution-design.md` and `docs/specs/2026-10-19-explicit-capture.md`.

## Capabilities (`workspace/projects/<name>/tasks/config.json`)

```json
{
  "resolver":  { "impl": "ollama", "host": "http://127.0.0.1:11434", "model": "qwen3:4b" },
  "dates":     { "impl": "chrono" },
  "generator": { "impl": "ollama", "host": "http://127.0.0.1:11434", "model": "qwen3:4b" },
  "agent":     { "impl": "claude-cli", "enabled": true },
  "collaborators": { "claude": { "use": "agent" }, "local": { "use": "generator" } },
  "thresholds": { "card": 0.6 },
  "jobs": { "max_parallel": 3 },
  "confirmation_timeout_s": 300,
  "done_ttl_s": 20,
  "ui": { "highlight_labels": ["highlight"], "accent_labels": { "urgent": "fire", "important": "violet" }, "private_label": "private" }
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
- `src/main/tasks/projects.ts` — workspace resolution, migration, bootstrap, project CRUD
- `src/renderer/` — minimal React sliver (divider + bounds reporting for the two WebContentsViews)
- `src/shared/` — shared types (`Instruction`, `Card`, `Snapshot`, `Registry`, `TaskdeckConfig`)
- `workspace/` — live data (projects/, current, templates/, .mcp.json)
