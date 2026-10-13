# Taskdeck — async, LLM-assisted task manager

A moui prototype built on the xweb shell. Status: implemented (prototype).

## Charter

Prove that a task manager controlled entirely by text can feel better than one controlled by clicking — when the intelligence layer is small, local, and only translates. You type "gotta write the ngo proposal this wed"; a card exists. You type "proposal for Y got declined"; the right card gets the status change and the message. The LLM never owns state, never generates the interface, never blocks you. Everything it does is a bounded decision you could have made with a flag.

Second thing to prove: data + interface + capabilities separation in a working tool. Files are the state, surfaces are disposable renderers, intelligence is swappable modules behind contracts.

## Principles (from the manifesto, made concrete)

- **#3 Data, interface, infrastructure separable** — `tasks/` is plain markdown you can read, edit, move, or grep. The surfaces render it. The capabilities interpret into it. Remove any layer, the data stands.
- **#4 Local first** — Laya runs in-process (ONNX, ~33ms). Ollama is a localhost call. `claude -p` is the only capability that may touch the network, and it is explicitly bound, never implied.
- **#5 Intelligence in service of agency** — models answer bounded questions (which action, which card, which status). They do not freewheel. Low confidence stops the machine and asks you.
- **No fallbacks** — every capability is bound by name in config. If a bound capability is unavailable, the instruction goes to `attention` carrying the real error. Nothing silently degrades.
- **Declarative over imperative** — a registry declares the actions that exist. A resolver matches text to an entry. A handler does the work. The engine is the pipe.

## Shape

```
 you type / agents POST / you edit files
            │
   ┌────────▼─────────┐     ┌──────────────────┐
   │  tasks/ (DATA)    │◄───►│ engine (pipe)     │──► capabilities (CONTRACTS)
   │  queue/ cards/    │     │ watch → resolve   │      resolver   = laya
   │  artifacts/       │     │ → gate → handle   │      dates      = chrono
   └────────▲─────────┘     └──────────────────┘      generator  = ollama
            │ SSE snapshots over one local API           agent      = claude -p
   ┌────────┴─────────┐
   │ surfaces (DUMB)   │  feed (left) · board (right) — vanilla pages,
   └──────────────────┘  render state, POST actions, hold nothing
```

## Data — `<workspace>/tasks/`

The filesystem is the zeroth API. Every other input path ends as a file write here; the watcher reconciles; hand edits are first-class and apply immediately.

```
tasks/
  config.json        # capability bindings + thresholds
  registry.json      # the actions that exist
  queue/             # one file per instruction (the feed renders this dir)
    2026-10-02T10-12-33-a3f.md
  cards/             # one file per card (the board renders this dir)
    proposal-x.md
  artifacts/         # delegation outputs
    proposal-x/2026-10-02T10-40-draft.md
```

**Instruction file.** Body is the raw utterance, verbatim, never rewritten. The engine only touches frontmatter:

```markdown
---
status: queued | working | needs_confirmation | attention | done
action: update_status          # resolved registry key
card: proposal-x               # resolved target
error:                         # present only on attention — the real error
---
proposal for Y got declined
```

**Card file.** Frontmatter is structured state; body is the description; the log is append-only history:

```markdown
---
title: Proposal for Y
status: inbox | active | waiting | done | dropped
created: 2026-10-01
due: 2026-10-08
links: [proposal-x]
labels: []
---
Funding proposal for Y foundation, deadline next week.

## Log
- 2026-10-02 10:12 — declined ("proposal for Y got declined")
```

Shortnames are slugs derived from the title (`proposal-y`); collisions append `-2`. `#shortname` in any instruction is an explicit reference that skips card resolution.

## Registry — `tasks/registry.json`

Declares what the engine can do. The resolver's choice space is exactly these keys. Adding an action = one entry + one handler.

```json
{
  "create":        { "class": "normal" },
  "update_status": { "class": "normal", "params": { "status": ["inbox","active","waiting","done","dropped"] } },
  "note":          { "class": "normal" },
  "link":          { "class": "normal" },
  "delete":        { "class": "destructive" },
  "delegate":      { "class": "normal", "params": { "executor": ["generator", "agent"] } },
  "clean":         { "class": "meta" }
}
```

Operation classes, enforced by the engine at the gate — never inside handlers, never in the UI:

- `normal` — executes.
- `destructive` — instruction parks as `needs_confirmation`; confirm in the feed (click or "yes") executes, timeout (config) rejects.
- `meta` — feed housekeeping (`clean` deletes `done` instruction files); handled in the pre-pass, never reaches the resolver.

## Engine

One module in the Electron main process. Watches `queue/` and `cards/` (chokidar). All state transitions are frontmatter writes — the engine holds nothing in memory that isn't derivable from the files.

Pipeline per instruction:

1. **Pre-pass (deterministic, no models):** meta-commands; `#refs`; dates via the `dates` capability ("this wed" → 2026-10-07); slug candidates.
2. **Resolve (bounded decisions):** the `resolver` capability answers typed multiple-choice questions — *which action* (over registry keys), *which card* (over ≤8 candidates from keyword overlap + recency, plus "none of these"), *which status* (over the registry's enum). Each answer carries a calibrated confidence; any answer below `config.thresholds` → `attention`.
3. **Gate:** operation class check (destructive → `needs_confirmation`).
4. **Handle:** the action's handler writes card files — create, frontmatter change + log line, link, delete. Title cleanup ("gotta write the application for X" → "Write application for X") goes through the `generator` capability if bound; if unbound, the raw text is the title. That is a declared binding, not a fallback.
5. **Delegate:** `delegate` runs the prompt through the bound executor (`generator` = ollama generate; `agent` = `claude -p`, spawned with cwd = workspace). Output → `artifacts/<card>/`, log line links it. Job pool capped by config.

Concurrency: instructions process in parallel; per-card FIFO so two updates to the same card never race. `attention` freezes that card's pending instructions until you resolve it (edit-and-requeue, or delete) — other cards keep flowing.

## Capabilities — contracts, bound by config

```ts
interface Resolver  { decide(q: Choice): Promise<{ key: string; confidence: number }> }
interface Dates     { extract(text: string, now: Date): { due?: string; cleaned: string } }
interface Generator { complete(prompt: string): Promise<string> }
interface Agent     { run(prompt: string, cwd: string): Promise<string> }
```

```json
{
  "resolver":  { "impl": "laya",   "checkpoint": "models/laya-typed.onnx" },
  "dates":     { "impl": "chrono" },
  "generator": { "impl": "ollama", "host": "http://127.0.0.1:11434", "model": "qwen3:4b" },
  "agent":     { "impl": "claude-cli", "enabled": true },
  "thresholds": { "action": 0.65, "card": 0.6, "status": 0.6 },
  "jobs": { "max_parallel": 3 },
  "confirmation_timeout_s": 300
}
```

A binding that fails to load throws at startup (surface the error in the feed); a binding that fails at runtime sends that instruction to `attention` with the error. Swapping implementations is editing this file.

## One API, every client equal

`127.0.0.1:7920`, stateless, a translator to the files:

- `POST /api/instructions {text}` — writes a queue file. Feed input, MCP `task` tool, and any external engine all use this one door.
- `GET /api/state` — full snapshot (queue + cards), derived from files on request.
- `GET /api/events` — SSE; watcher broadcasts state snapshots; surfaces re-render.
- `POST /api/instructions/:id` — `{action: requeue|delete|confirm|reject, text?}`.
- `POST /api/cards/:shortname` — `{description?} | {action: delete}` (delete routes through the destructive gate like everything else).

MCP tools (same server): `task(instruction)` → `POST /api/instructions`; `screenshot`. Nothing else.

## Surfaces — dumb by construction

Vanilla HTML/CSS/TS pages served from the same server, hosted as two WebContentsViews. No framework, no client state beyond the DOM, no build-time UI layer. They render SSE snapshots and POST. Transitions carry the semantics:

- **Feed (left, `/feed`)** — input line at the bottom; Enter POSTs and acks instantly (`→ queued`), parsing never blocks typing. `#` autocompletes shortnames from the last snapshot. Rows above the input: working rows glow; `needs_confirmation` rows show confirm/reject; `attention` rows are highlighted; `done` rows drift into a collapsed section at top. Click a row → inline detail: raw text, what the engine did or the real error; edit-and-requeue; delete.
- **Board (right, `/board`)** — five columns from card status. Minimal card: title, shortname, due, labels, link chips. Click → detail: full description (editable), log, artifacts, delete. FLIP transitions on column moves.

The Electron renderer shrinks to a sliver: divider + bounds reporting for the two views.

## What leaves the codebase (vs `gdpr` tip)

- `src/main/persona/` entirely (engine, pages, db) — and `better-sqlite3` with it
- Claude autolaunch, `commandExists`, pty/xterm stack (`node-pty`, `@xterm/*`, TerminalPane, `/x` interception)
- `browser`/`files`/`pane` MCP tools and the intent resolver
- React and react-dom (renderer becomes a static sliver), their eslint plugins
- `projects/landing-site`, `templates/astro` (different product; `projects/` convention stays for the workspace)

Kept: window/tab/browser-view infra, HTTP+MCP server, screenshot tool + cleanup, single-instance lock, teardown guards, env config.

## Transient implementation choices (prototype, not philosophy)

Electron shell, chokidar, Laya via `receptron/laya` (onnxruntime-node), Ollama HTTP API, `claude -p`, chrono-node, gray-matter for frontmatter. Any of these can be swapped without touching the contracts; that is the point.

## Testing

Engine internals are pure functions tested without models: pre-pass extraction, candidate selection, slug collision, per-card serialization, attention freeze, confirmation gate, writer idempotence (re-running an applied instruction is a no-op). Capabilities are faked through their contracts in vitest. Laya/Ollama integration is exercised manually in the running app; CI never needs a model.

## What we want to learn

- Does per-utterance file-in-queue survive real use, or does it need batching/editing before parse?
- Is Laya's calibrated confidence good enough to make `attention` rare but trustworthy?
- Does the registry + resolver pattern stay clean as actions grow, or does parameter extraction (beyond dates/status) force a generator into the hot path?

### Learnings (2026-10-02, build)

- The real Laya API (`Laya.load({ modelDir })`, `systemOne()`) differed from every assumption; the capability contract confined the change to one file.
- "Files are the state" caught real bugs: freeze/confirmation state had to be re-derived from frontmatter at boot, or restarts broke attention semantics.
- Model-free CI held: 56 tests cover engine semantics end to end with scripted resolvers; no model needed until the surfaces.
