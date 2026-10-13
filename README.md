# snarky-task

You type plain text. A card exists, or gets updated, or gets the right status. The model makes bounded decisions; you see what it did as files you can read, edit, or grep. Files are the state — surfaces are disposable renderers, intelligence is swappable modules behind contracts.

<!-- screenshot placeholder -->

## Quick start

```bash
npm install
```

Then pick a resolver:

**Option A — Ollama (default)**
```bash
ollama pull qwen3:4b   # ~2.3 GB; start ollama first if it isn't running
```

**Option B — Laya (local ONNX, ~33ms inference)**
Download the bundle and flip `resolver.impl` to `"laya"` in `workspace/tasks/config.json`. See `docs/laya.md` for the full procedure.

Then start the app:

```bash
npm run dev
```

The feed opens at `127.0.0.1:7920/feed`, the board at `/board`. Type your first instruction:

```
gotta write the ngo proposal this wed
```

A card appears on the board. The feed shows what the engine resolved.

## How input works

Three ways in, all equivalent — all end as a file write in `workspace/tasks/`:

- **Type** in the feed (`/feed`) and press Enter.
- **Click** a card or row to edit its description, log, or frontmatter directly.
- **Hand-edit** files in `workspace/tasks/queue/` or `workspace/tasks/cards/` — the watcher picks up changes immediately.

MCP tool `task(instruction)` is a fourth path, identical to feed input. Use it when an external agent needs to post instructions.

## Architecture

```
 you type / agents POST / you edit files
             │
   ┌─────────▼──────────┐     ┌──────────────────┐
   │  workspace/tasks/   │◄───►│ engine           │──► capabilities (CONTRACTS)
   │  queue/ cards/       │     │ watch → resolve  │      resolver   = ollama | laya
   │  artifacts/          │     │ → gate → handle  │      dates      = chrono
   └─────────▲──────────┘     └──────────────────┘      generator  = ollama
             │ SSE snapshots                              agent      = claude -p
   ┌─────────┴──────────┐
   │ surfaces (dumb)     │  /feed (left) · /board (right)
   └────────────────────┘  render state, POST actions, hold nothing
```

Four layers:

- **Data** — `workspace/tasks/`: plain markdown files. Remove any other layer; the data stands.
- **Surfaces** — `/feed` and `/board` at `127.0.0.1:7920`: vanilla HTML/CSS/TS, no framework, no client state.
- **Capabilities** — resolver, dates, generator, agent. Bound by name in `workspace/tasks/config.json`. Swap by editing that file.
- **Engine** — watches `workspace/tasks/`, runs the pipeline (pre-pass → resolve → gate → handle → delegate), writes frontmatter. Holds nothing in memory that isn't derivable from files.

## Other commands

```bash
npm run build        # typecheck + production build
npm run typecheck    # typecheck only
npx vitest run       # run tests (no model needed — resolvers are faked in CI)
```

## Environment variables

| Variable | Effect |
|---|---|
| `XWEB_WORKSPACE` | Workspace directory (default: `./workspace`) |
| `XWEB_MCP_PORT` | HTTP + MCP server port (default: `7920`) |
