# Content-element data model

Date: 2026-10-22
Status: proposed

## Why

A card hardcodes `description`, `notes[]`, `log[]`, `labels`, `links`. Every new kind of
content — a date, a person, a CRM field — means another hardcoded field, another parser
branch, another render path. That is imperative growth: more coupled code per type, more
places to get it wrong. We are about to add types (a calendar, people, later a bit of CRM),
so the task manager can become a workspace. Repair the structure before adding to it.

The fix is the pattern snarky-task already uses for verbs, turned on content: a registry
declares what exists, a schema validates it, a handler does the work, the engine is the pipe.
Vocabulary from moui: a card is a **bite** (a typed content instance that declares its schema);
each kind of content is a **shape** (schema + ops); changes are **ops** on stable-id elements.
snarky-task stores the materialized current value, not an op log — a log does not share well,
and it would make a low-power / mobile client fold every op just to show a card.

## Goals

- A card body is an ordered set of typed **content elements**, each `{ id, type, …data }`.
- Element types are declared once in a **registry** (schema + ops + serialization). No per-type
  imperative code in the engine.
- Every element has a stable id — a handle for the CLI, the UI, and hand edits.
- Notes, description, log are element types, not special fields. Adding `date` / `person` is
  adding a shape.
- One hand-readable, hand-editable file per card. Current value stored directly.
- Existing verbs keep working; they dispatch element ops.

## Non-goals

- No op log / event sourcing. Current value only.
- No separate per-element files or content-addressed store. Elements live in the card for
  readability; a type can be promoted to its own store later without changing its interface.
- Not building calendar / people / CRM now — only the structure that makes them cheap to add.
- `labels` / `links` stay card-level for now (candidates to become `tag` / `link` element
  types later; out of scope here).

## Anti-goals

- A fallback or default that hides what an element is. Unknown type or invalid element parks
  loud; never silently coerce.
- Type logic inlined in the engine. The engine must not tell a note from a date except through
  the registry and the shape contract.

## Constraints

- Files are the state; hand edits are first-class (the reconciler already absorbs them).
- Schema-validated at read and write. Extends the content-schema-validation design
  (`2026-10-20-content-schema-validation-design.md`).
- Synced workspaces: ids must survive sync; the reconciler handles the rare collision.
- Offline, low-power clients: reading a card is parsing one file, not folding a log.

## The model

### Element

`{ id: string, type: string, ...data }` — `data` is type-specific and validated by the type's
schema.

### Shape — one per type, behind a contract

A content-element type is a shape. The engine talks to it only through this contract (same
spirit as the capability contracts for resolver / dates / generator / agent):

```ts
interface ElementShape {
  type: string                  // "note" | "date" | "person" | "log" | "text" | "output"
  schema: string                // JSON Schema file (note.v1.json) — validates `data`
  ops: string[]                 // declared actions: ["add","edit","scratch","drop"]
  storage: 'body' | 'fs'        // body → serialized in the card; fs → derived from a sidecar
  section?: string              // file section header ("Notes"); absent → lead
  lead?: boolean                // the card's lead text element (description)
  system?: boolean              // system-authored, append-only, no minted id (log)
  // body storage:
  parse?(block: string): { id: string; data: Record<string, unknown> }
  render?(el: Element): string  // element → one file block (may be multi-line)
  // fs storage:
  materialize?(tasksDir: string, shortname: string): Element[]  // read elements from the sidecar
}
```

`parse` / `render` are **file (de)serialization only** — the shape owns how its content reads
on disk, nothing about the UI. They are **block-oriented, not line-oriented**: a block is the
lead text (everything before the first `##`), or one `- ` bullet and its folded continuation
lines within a section. This lets the lead `text` and a multi-line note round-trip without the
engine special-casing them.

The engine never parses a note or a date itself. It splits the body into (section → blocks),
hands each block to the type's `parse`, validates `data` against `schema`, and dispatches ops
through the type's handlers. Contracts, not logic. A new type ships a shape; the engine does
not change.

### Registry

`workspace/projects/<p>/tasks/elements.json`, parallel to `registry.json`:

```json
{
  "text":   { "schema": "text.v1.json",   "lead": true,            "ops": ["edit"] },
  "note":   { "schema": "note.v1.json",   "section": "Notes",      "ops": ["add","edit","scratch","drop"] },
  "date":   { "schema": "date.v1.json",   "section": "Dates",      "ops": ["add","edit","drop"] },
  "person": { "schema": "person.v1.json", "section": "People",     "ops": ["add","edit","drop"] },
  "output": { "schema": "output.v1.json", "storage": "fs",         "ops": ["add","edit","drop"] },
  "log":    { "schema": "log.v1.json",    "section": "Log", "system": true, "ops": ["append"] }
}
```

**Storage mode.** A shape declares where its elements live. `storage: "body"` (the default)
— the element serializes to a block in the card file (text, note, date, person, log). `storage:
"fs"` — the element is derived from a sidecar and its content lives outside the card body
(`output`: one element per file in `artifacts/<shortname>/`; `data: { file }`; content in the
file). Both kinds are `Element`s with the same op interface, so the UI edits and drops any
element the same way — **agent outputs get the identical edit mechanics as notes (editable with
save / cancel, droppable), minus scratch.** Only the storage differs: a `body` shape round-trips
through `parse`/`render`; an `fs` shape is materialized from its sidecar and its ops touch the
sidecar. Everything is a declaration — a type's storage, schema, and ops are data, not code.

The registry binds `type → shape` by name, the same way capabilities bind by name — a binding
that fails to load throws at startup, a type that is bound but missing from a card's registry
parks that op loud. Reconciled from the template at boot (the same mechanism that backfills
`registry.json`), so stale decks gain new types without a hand edit.

### Storage / serialization

One markdown file per card. Frontmatter holds the card's own identity and state; the body holds
the elements — the lead `text` first, then one `##` section per type in registry order, log
last (append-friendly).

```markdown
---
v: 2
id: 01J8F2…
title: decisiones
status: active
created: 2026-10-22
labels: [highlight]
links: []
---

la recolección de las cosas que aclaramos y que vamos decidiendo…

## Notes
- n8k2 · 08:53 — vamos a inscribirnos en una visión honesta…
- n3f1 · 08:54 — no vamos a tener orgullo, vamos a ser humildes…
- n1aa · 07:20 · scratched — preguntar a Ana por el calendario

## Dates
- d4c7 · 2026-11-02 · deadline — enviar propuesta

## People
- p9x2 · ana · owner

## Log
- 2026-10-22 08:14 — created
- 2026-10-22 08:14 — status → active
```

The line format is owned by each shape's `parse` / `render`. The bundled convention is
`- <id> · <attrs> — <text>`. The UI hides ids (click to act); the file and CLI show them.

### Element identity

Type-prefix + 4 base36 chars, de-duped within the card at creation (`n8k2`, `d4c7`). Short
enough to type (`scratch n8k2`), enough entropy to avoid an in-card collision; cross-device
collisions are rare and the reconciler resolves them. (Call: short over globally unique;
revisit if sync shows collisions.)

### Verbs → ops

A verb that names an element id dispatches that element's op:

- `note <text>` → `note.add` on the open / named card.
- `scratch <id>` → `note.scratch`.
- `edit <id> <text>` → the type's `edit`.
- `drop <id>` → element `drop` (an element id disambiguates from card `drop #card`).

Element ids are referenced bare (they match the id pattern) against the open card, or qualified
`#card n8k2`. The open-card fallback already supplies the card. The registry says which ops a
type allows; an op a type does not declare parks loud.

### Validation

`/check` validates each card against `card.v2.json` and each element against its type's schema
through the registry. Unknown type or failed validation → attention, never silent.

### Migration (v1 → v2)

One-time, at read (written back on next save) or via a meta command:

- Body text before `## Notes` → one `text` (lead) element.
- `## Notes` lines (`<ts> — <text>`) → `note` elements (`at` = ts, text, fresh ids).
- `## Log` lines → `log` elements.
- `labels` / `links` stay in frontmatter. `v: 1 → v: 2`.

Backward read: v1 cards read through a shim until migrated. The mapping is mechanical and
hand-rollable.

## Decisions from the builder check

Resolutions to the forks a reviewer raised. Each is a call; change any that reads wrong.

1. **`Card` holds `elements: Element[]` as the canonical model; derived getters stage the
   migration.** `Card.description` / `.notes` / `.log` become computed views over `elements`
   for the five bundled types, so `context.ts`, `reconcile.ts`, the handlers, the snapshot, and
   the surfaces don't all rewrite at once. The views are read-only convenience over the one
   source of truth; a *new* type (date, person) is reached only through `elements` + the
   registry — never a new typed field. The goal (no field per type in storage) holds; the getters
   are a UI/compat convenience for known types, not storage.

2. **The snapshot ships `elements[]` plus the registry's render hints; surfaces render per-type
   from element data, not from file lines.** `shape.render` is file serialization (main process,
   reads bundled schemas); the browser never runs it. The surface has its own small per-type UI
   renderer keyed on `element.type`, fed the element `{ id, type, data, ops }` so click-to-act,
   double-click-to-edit, and `scratch · drop` have the id and the allowed ops. Two render
   concerns, deliberately separate: disk format (shape) vs. DOM (surface).

3. **`log` is the degenerate element: `system: true` → no minted id, identity is the line
   text.** `appendLog` stays a cheap EOF append of `- <ts> — <text>`; `diffCard`'s string-equality
   dedup (load-bearing for synced "logged-at-source vs. direct-edit") is unchanged. Minting
   per-device ids on log lines would break that dedup, so log lines carry none.

4. **Element ops apply immediately, but a `drop` is recoverable — no confirmation gate.**
   `scratch` / `edit` apply in place and are recorded in the log. `drop` (element or output)
   also applies immediately but is *recoverable*: the dropped record is moved to
   `<tasksDir>/.trash/` (`<shortname>.jsonl` for elements, `.trash/artifacts/<card>/` for
   output files) and the board shows a transient "dropped · undo" bar that POSTs
   `/api/cards/:shortname/restore` → `engine.restoreLastDrop`, which pops the last trash
   record and re-inserts it (preserving the element id / moving the file back). `.trash`
   stays greppable for later recovery. This keeps element ops off the confirmation
   round-trip — an in-body element id never has to survive frontmatter — while honoring
   the rule that no destructive op is irreversible (superseding the earlier
   "non-destructive, nothing to undo" framing; a materialized store still owes recoverability).
   Only card-level `delete` / `reslug` carry a confirmation gate.

5. **CLI element-id resolution: the engine passes the open/named card's element inventory into
   `CliDeps`.** `parseCommand` gains `elements?: {id,type}[]` for the target card (the engine
   already reads that card). The parser recognizes a bare id by pattern, validates it against the
   inventory, and routes `drop <id>` → element drop vs. `drop #card` → card delete by whether the
   ref is an element id or a card slug. The resolved element id rides execution as a new
   `CliCommand.element` field (not frontmatter — element ops aren't confirmed, so no round-trip).

6. **Verb → op map.** Existing card verbs stay. `describe <text>` → `text.edit` on the lead.
   `note <text>` → `note.add`. New verbs: `scratch <id>` → `note.scratch`; `edit <id> <text>` →
   `<type>.edit`. `drop` already aliases to `delete` — `drop <elementId>` routes to element drop,
   `drop #card` to card delete. `elements.json` declares the ops a type allows; a small
   verb→(type,op) table in the CLI binds verbs to them. An op a type doesn't declare parks loud.

7. **Boot order and migration.** At bind, reconcile `elements.json` from the template *before*
   reading cards (so shapes exist to migrate into), same mechanism as `reconcileRegistry`.
   Migration is **lazy**: a v1 card reads through a v1→v2 shim in memory and is **not** rewritten
   on read — it is written as v2 only when the user actually edits it. This avoids a read
   silently churning files and avoids v1/v2 flip-flop between synced devices. Both machines run
   the same app version, so a v2 write syncs to a v2 reader.

## What's left to the builder

- The `ElementShape` contract and the five bundled shapes (text, note, date, person, log) —
  each with `parse` / `render` / `schema` / `ops` handlers.
- `elements.json` registry: loader, template, boot reconciliation.
- `card.v2.json` and the per-type schemas.
- Card read/write refactor: `Card` holds `elements: Element[]` in place of
  `description / notes / log`; serialize through the shapes.
- Verb → op dispatch: element-id resolution in the CLI; op routing through the registry.
- Migration pass and `/check` extension.
- Board / feed render: notes, dates, people, log drawn from elements; the approved note UI
  (regular-weight Garamond, separated left bars, double-click to edit with `save · cancel`,
  resting `scratch · drop`), and the log demoted to the quiet `activity` strip.
- Keep the engine free of per-type logic — every type behavior goes through the contract.
