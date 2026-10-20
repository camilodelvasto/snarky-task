# Content schema & validation (Tier 1) — design

**Date:** 2026-10-20
**Status:** approved in conversation
**Context:** adopts the moui "schema as contract" pattern (018-workspace) for snarky-task's
content side, mirroring the action side that `registry.json` already declares. This is
Tier 1 of the evaluation: a declared content schema + boundary validation + versioning +
atomic writes, WITHOUT changing the CLI/ops (Tier 2+) or the files-are-state model.

## Why

The `Card`/`Instruction` data model is a TypeScript interface only — compile-time, not
enforced. `readCard`/`readInstruction` trust gray-matter's output completely, so a
hand-edit typo or a half-written file flows through as corrupt state. There is no schema
file, no self-description, no atomic write. This is the gap flagged in the data-model
review; it bites hardest as a project syncs between machines.

moui's answer (studied in 018-workspace): content types are **declared as versioned JSON
Schema**, files are **self-describing** (frontmatter names its schema version), and every
file is **validated at the read and write boundaries** with `jsonschema.validate`. `mo
check` validates the whole workspace. Writes are atomic (temp + rename).

snarky-task already has the symmetric half — `registry.json` declares actions and the
engine routes by it. Tier 1 adds the content-schema half.

## Scope (what Tier 1 IS and ISN'T)

- **IS:** JSON Schemas for the card and instruction *frontmatter*; a `v:` version field;
  validation at read + write; a `check` meta command; atomic file writes; a small
  body-parser hardening (line-anchored section split).
- **IS NOT:** schema-driven handlers/CLI (Tier 2), multiple content types (Tier 3),
  event-sourced ops (Tier 4). Handlers, the CLI, the ops stay exactly as they are.
- JSON Schema validates **frontmatter** (YAML). The markdown body (`description`, the
  `## Notes` / `## Log` sections) stays markdown — schema covers the structured metadata,
  as in moui (frontmatter validated, body is markdown). The body split is hardened but
  not JSON-Schema-validated.

## Schemas

Two draft-07 JSON Schema files ship with the app (bundled, not per-project), read at
runtime by `files.ts`:

- `src/main/tasks/schema/card.v1.json`
- `src/main/tasks/schema/instruction.v1.json`

`additionalProperties: false` (catches typos — a misspelled field is an error, not silent
drift). Schema evolution is additive (add optional properties to v1) or a new `v2` file.

### card.v1.json — validates card frontmatter

Frontmatter fields (the body carries description/notes/log, NOT validated here):

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "card.v1.json",
  "title": "snarky-task Card (frontmatter)",
  "type": "object",
  "additionalProperties": false,
  "required": ["title", "status", "created", "links", "labels"],
  "properties": {
    "v": { "type": "integer", "const": 1 },
    "title": { "type": "string", "minLength": 1 },
    "status": { "type": "string", "enum": ["inbox", "active", "waiting", "done", "dropped"] },
    "created": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    "due": { "type": "string" },
    "links": { "type": "array", "items": { "type": "string" } },
    "labels": { "type": "array", "items": { "type": "string" } }
  }
}
```

### instruction.v1.json — validates instruction frontmatter

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "instruction.v1.json",
  "title": "snarky-task Instruction (frontmatter)",
  "type": "object",
  "additionalProperties": false,
  "required": ["status"],
  "properties": {
    "v": { "type": "integer", "const": 1 },
    "status": { "type": "string", "enum": ["queued", "working", "needs_confirmation", "attention", "done"] },
    "action": { "type": "string" },
    "card": { "type": "string" },
    "to": { "type": "string" },
    "title": { "type": "string" },
    "desc": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "due": { "type": "string" },
    "with": { "type": "string" },
    "scope": { "type": "string", "enum": ["card", "full", "board"] },
    "via": { "type": "string", "enum": ["cli", "ai", "cli+ai"] },
    "engine": { "type": "string" },
    "model": { "type": "string" },
    "version": { "type": "string" },
    "ms": { "type": "number" },
    "pick": { "type": "number" },
    "error": { "type": "string" },
    "result": { "type": "string" }
  }
}
```

Note: these must be kept in sync with the TS types. A test asserts the two never drift
(every `Instruction`/`Card` frontmatter field the writers emit is a declared property).

## Self-description: the `v:` field

Every card and instruction frontmatter gains `v: 1` on write. On read, `data.v ?? 1`
(legacy files with no `v` are treated as version 1 and validated against `*.v1.json`).
This is the hook future migrations use; Tier 1 ships only v1.

## Validation module

`src/main/tasks/validate.ts`:

```ts
export interface ValidationError { field: string; message: string }
export function validateCard(frontmatter: unknown): ValidationError[]       // [] when valid
export function validateInstruction(frontmatter: unknown): ValidationError[]
```

- Uses `ajv` (draft-07; already present transitively — pin it as a direct dependency).
- Compiles each schema once (module-level), keyed by version; selects by `frontmatter.v ?? 1`.
- An unknown `v` (e.g. `v: 2` with no v2 schema) returns a single error
  `schema version 2 not supported` — fail loud, never silently pass.

## Boundary behavior

- **Write** (`writeCard`, `writeInstruction`, `patchInstruction`): validate the frontmatter
  about to be written; throw `Error('card/instruction invalid: <field>: <message>; …')` if
  invalid. This catches OUR bugs — the engine can never persist malformed state. Writers
  always set `v: 1`.
- **Read** (`readCard`, `readInstruction`): validate the parsed frontmatter; on failure
  throw `Error('<path> invalid against <schema>: <errors>')`. Existing callers already
  `try/catch` and skip-with-`console.error` (`readSnapshot`, engine boot) — behavior is
  unchanged except the error is now precise. (Surfacing invalids in the UI is a Tier-1.5
  follow-up, out of scope here.)
- No-fallbacks preserved: a validation failure is a real error that parks/skips loudly,
  never a silent coercion.

## Atomic writes

A `writeFileAtomic(path, data)` helper (temp file in the same dir + `renameSync`) replaces
`writeFileSync` in `writeCard`, `writeInstruction`, `patchInstruction`, and the artifact
writes in the engine. `appendLog` (`appendFileSync`) stays as-is — a single small append
is atomic enough on a local fs, and making it read-modify-write would regress its cost.

## `check` meta command

A new meta action `check` (registry `class: meta`, like `clean`/`clear`). Prepass routes
it; the engine handles it by walking `cards/`, `queue/`, and `history/`, validating every
file, and writing the report into the instruction's `result` frontmatter (shown in the
feed drawer):

```
checked 42 files — 2 invalid
  cards/press-plan.md: status: must be one of inbox, active, waiting, done, dropped
  queue/2026-…-ab.md: unknown property "tag" (did you mean "tags"?)
```

`check` reads only; it never mutates or quarantines in Tier 1 (surfacing/quarantine is a
follow-up). An all-clean run reports `checked N files — all valid`.

## Body-parser hardening (small, included)

`readCard` currently splits the body with `content.split('## Log')` / `.split('## Notes')`,
which matches those strings anywhere (a description containing "## Log" mis-splits). Change
to line-anchored matching (`/^## Log$/m`, `/^## Notes$/m`) so only real section headers
split. Documented constraint: a card body may not use `## Log` / `## Notes` as its own
headings (acceptable — they're reserved section names).

## Non-goals / deferred

- UI surfacing of invalid cards (broken-card state on the board) — Tier 1.5.
- Quarantine of invalid files (move to `.quarantine/`) — Tier 1.5.
- Schema-driven handlers/CLI, multiple content types, event sourcing — Tiers 2–4.

## Testing

- `validate.ts`: valid frontmatter → `[]`; each invalid case (bad enum, missing required,
  wrong type, additionalProperty, bad `created` pattern, unknown `v`) → the right error.
- `files.ts`: round-trip writes `v: 1`; `readCard`/`readInstruction` throw on a
  schema-invalid file; `writeFileAtomic` leaves no temp file and the final file is complete;
  body-parser line-anchoring (a description containing the literal "## Log" is preserved).
- `engine`: `check` validates the workspace and reports invalids in `result`; a clean
  workspace reports all-valid; `check` mutates nothing.
- Schema/type drift guard: a test enumerating the frontmatter keys each writer emits and
  asserting every one is a declared schema property.
- Gate unchanged: typecheck, eslint max-warnings 0, vitest.
