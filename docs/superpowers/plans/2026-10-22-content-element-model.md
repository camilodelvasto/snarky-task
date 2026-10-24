# Content-element model — data foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a card's body as typed content elements behind a registry of shapes, so new content types (date, person, …) are a registry entry + schema + shape, not an engine change — with existing behavior and all current tests intact.

**Architecture:** A card holds `elements: Element[]` as the source of truth. Each element type is an `ElementShape` (schema + ops + file (de)serialization) bound by name from a bundled map, declared in `elements.json`. `readCard`/`writeCard` (de)serialize the body through the shapes; `readCard` also computes legacy `description/notes/log` as read-only derived fields so `context.ts`, `reconcile.ts`, the snapshot, and the surfaces are untouched this plan. Write paths (handlers) move onto element ops. v1 cards read through a shim and are rewritten to v2 only on edit.

**Tech Stack:** TypeScript, Node, vitest, gray-matter (frontmatter), ajv (existing schema validation via `validate.ts`).

**Spec:** `docs/specs/2026-10-22-content-element-model-design.md`

## Global Constraints

- No fallbacks: a type in `elements.json` with no bundled shape throws at load; an unknown element type or a schema-invalid element parks loud / throws — never silently coerced. (CLAUDE.md "Development principles".)
- Contracts, not logic: the engine never branches on element type; all type behavior goes through `ElementShape`.
- Files are the state; hand edits are first-class and must round-trip. Schema-validated at read and write.
- One hand-readable file per card. Current value only (no op log).
- Element id: type-prefix (`type[0]`) + 4 base36 chars, unique within the card; `log` elements carry no minted id (identity = line content).
- Card schema version bumps `v: 1 → v: 2`. v1 reads through a shim; rewrite to v2 only on an actual write.

## Review Focus

- **A hand-edited note line missing its id** (someone types `- a new thought` under `## Notes`) → must parse into a note with a freshly minted id, not throw. Pinned in Task 8.
- **A note whose text contains ` — ` or ` · `** (the field separators) → must round-trip without truncation; only the first separators are structural. Pinned in Task 3.
- **A multi-line note / multi-line lead text** (folded continuation lines) → must round-trip intact. Pinned in Tasks 2 and 3.
- **A synced log line arriving via a direct card edit** → `diffCard` must still treat it as logged-at-source, not re-log it as `(direct edit)`; log elements keep content-identity so the dedup holds. Pinned in Task 9.
- **An empty card (no notes, no description)** → serializes and re-reads to an equal element set (no spurious empty `text`/sections). Pinned in Task 8.

---

### Task 1: Element model + shape contract + id minter

**Files:**
- Create: `src/main/tasks/elements/types.ts`
- Create: `src/main/tasks/elements/id.ts`
- Test: `src/main/__tests__/elements-id.test.ts`

**Interfaces:**
- Produces:
  - `interface Element { id: string; type: string; data: Record<string, unknown> }`
  - `interface ElementShape { type: string; schema: string; ops: string[]; storage: 'body'|'fs'; section?: string; lead?: boolean; system?: boolean; parse?(block: string): { id: string; data: Record<string, unknown> }; render?(el: Element): string; materialize?(tasksDir: string, shortname: string): Element[] }` — `parse`/`render` on `body` shapes; `materialize` on `fs` shapes.
  - `type ShapeMap = Record<string, ElementShape>`
  - `function mintId(prefix: string, taken: Set<string>): string` — `prefix` + 4 base36 chars, not in `taken`.

- [ ] **Step 1: Write the failing test** — `elements-id.test.ts`: `mintId('n', new Set())` matches `/^n[0-9a-z]{4}$/`; `mintId('n', set-of-all-but-one)` returns the free id; 100 mints into one set are all unique.
- [ ] **Step 2: Run test — expect FAIL** (`mintId` not defined). `npx vitest run src/main/__tests__/elements-id.test.ts`
- [ ] **Step 3: Implement `mintId`** in `elements/id.ts` (loop minting until not in `taken`); declare the interfaces in `elements/types.ts`.
- [ ] **Step 4: Run test — expect PASS.**
- [ ] **Step 5: Commit** (`git add src/main/tasks/elements/ src/main/__tests__/elements-id.test.ts && git commit -m "feat(elements): Element + ElementShape contract, id minter"`).

---

### Task 2: `text` shape (lead) + schema

**Files:**
- Create: `src/main/tasks/elements/text.ts`, `src/main/tasks/schema/text.v1.json`
- Test: `src/main/__tests__/elements-shapes.test.ts` (new; extended by Tasks 3–6)

**Interfaces:**
- Consumes: `ElementShape`, `Element` (Task 1).
- Produces: `export const textShape: ElementShape` — `type:'text'`, `schema:'text.v1.json'`, `lead:true`, `ops:['edit']`, no `section`. `parse(block)` → `{ id:'lead', data:{ text: block.trimEnd() } }`. `render(el)` → `el.data.text as string` (no bullet, no id). `text.v1.json` requires `text: string`.

- [ ] **Step 1: Write the failing test** — round-trip: `textShape.render({id:'lead',type:'text',data:{text:'line one\nline two'}})` equals `'line one\nline two'`; `textShape.parse('line one\nline two')` deep-equals `{id:'lead',data:{text:'line one\nline two'}}`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `textShape`** and `text.v1.json`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(elements): text lead shape`).

---

### Task 3: `note` shape + schema

**Files:** Create `src/main/tasks/elements/note.ts`, `src/main/tasks/schema/note.v1.json`. Test: extend `elements-shapes.test.ts`.

**Interfaces:**
- Produces: `export const noteShape: ElementShape` — `type:'note'`, `schema:'note.v1.json'`, `section:'Notes'`, `ops:['add','edit','scratch','drop']`. `data`: `{ at: string; text: string; scratched?: boolean }`. `render` → `- <id> · <at>[· scratched] — <text>` (text keeps its own ` — `/` · `). `parse` reads `- <id> · <at> [· scratched] — <rest>`: id = token after `- `, `at` = next ` · `-delimited token, optional `scratched` flag, `text` = everything after the FIRST ` — ` (folded continuation lines joined with `\n`). `note.v1.json` requires `at`, `text`; `scratched` optional boolean.

- [ ] **Step 1: Write the failing tests** — round-trip a plain note; a scratched note; **a note whose text contains ` — ` and ` · `** (asserts only the first separators are structural); **a multi-line note** (continuation line folded into `text`); **a hand-typed line with no id** parses with `id:''` sentinel (the serializer mints it in Task 8 — assert `parse('- just a thought').data.text === 'just a thought'`).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `noteShape`** + `note.v1.json`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(elements): note shape`).

---

### Task 4: `log` shape + schema (system, content-identity)

**Files:** Create `src/main/tasks/elements/log.ts`, `src/main/tasks/schema/log.v1.json`. Test: extend `elements-shapes.test.ts`.

**Interfaces:**
- Produces: `export const logShape: ElementShape` — `type:'log'`, `schema:'log.v1.json'`, `section:'Log'`, `system:true`, `ops:['append']`. `data`: `{ line: string }` (the full legacy log line, e.g. `2026-10-22 08:14 — created`). `render` → `- <line>`. `parse('- <line>')` → `{ id: line, data:{ line } }` (id = content, so no mint, stable across devices). `log.v1.json` requires `line: string`.

- [ ] **Step 1: Write the failing test** — round-trip `- 2026-10-22 08:14 — created`; assert `parse(...).id === parse(...).id` for identical lines (content-identity) and differs for different lines.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `logShape`** + `log.v1.json`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(elements): log shape`).

---

### Task 5: `date` shape + schema (proves a non-text type)

**Files:** Create `src/main/tasks/elements/date.ts`, `src/main/tasks/schema/date.v1.json`. Test: extend `elements-shapes.test.ts`.

**Interfaces:**
- Produces: `export const dateShape: ElementShape` — `type:'date'`, `schema:'date.v1.json'`, `section:'Dates'`, `ops:['add','edit','drop']`. `data`: `{ on: string; label?: string; text?: string }` (`on` = `YYYY-MM-DD`). `render` → `- <id> · <on>[· <label>][ — <text>]`. `parse` inverse. `date.v1.json` requires `on` matching `^\d{4}-\d{2}-\d{2}$`.

- [ ] **Step 1: Write the failing test** — round-trip `- d4c7 · 2026-11-02 · deadline — enviar propuesta`; round-trip a date with no label/text (`- d4c7 · 2026-11-02`).
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement `dateShape`** + `date.v1.json`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(elements): date shape`).

---

### Task 6: `person` + `output` shapes + schemas

**Files:** Create `src/main/tasks/elements/person.ts`, `src/main/tasks/elements/output.ts`, `src/main/tasks/schema/person.v1.json`, `src/main/tasks/schema/output.v1.json`. Test: extend `elements-shapes.test.ts`, new `src/main/__tests__/elements-output.test.ts`.

**Interfaces:**
- Produces:
  - `export const personShape: ElementShape` — `type:'person'`, `storage:'body'`, `section:'People'`, `ops:['add','edit','drop']`. `data`: `{ ref: string; role?: string }`. `render` → `- <id> · <ref>[· <role>]`. `person.v1.json` requires `ref`.
  - `export const outputShape: ElementShape` — `type:'output'`, `storage:'fs'`, `ops:['add','edit','drop']` (no scratch). `data`: `{ file: string }`. No `parse`/`render` (not in the card body). `materialize(tasksDir, shortname)` → one `output` element per file in `artifacts/<shortname>/` (id minted stably from the filename, e.g. `'o'+hash(file)`; content stays in the file). `output.v1.json` requires `file`.

- [ ] **Step 1: Write the failing tests** — person round-trips `- p9x2 · ana · owner` and `- p9x2 · ana`; `outputShape.materialize` on a temp `artifacts/foo/` with two files returns two `output` elements whose `data.file` match the filenames and whose ids are stable across calls; `outputShape` has no `scratch` in `ops` and no `parse`/`render`.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `personShape`, `outputShape`, and both schemas.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(elements): person + output shapes`).

---

### Task 7: Element registry — `elements.json`, loader, template, reconciliation

**Files:**
- Create: `src/main/tasks/elements/registry.ts`
- Create: `workspace/templates/default/elements.json`
- Modify: `src/main/tasks/projects.ts` (ensure/backfill `elements.json` like `config.json`/`registry.json` in `ensureProjectDirs`/`ensureDefaultProject`)
- Modify: `src/main/project-manager.ts` (call `reconcileElements` at bind, alongside `reconcileRegistry`)
- Test: `src/main/__tests__/elements-registry.test.ts`

**Interfaces:**
- Consumes: the five+`text` shapes (Tasks 2–6).
- Produces:
  - `const BUNDLED: ShapeMap` — `{ text, note, date, person, output, log }` bound by `type`.
  - `function loadElements(tasksDir: string): { types: Record<string, {schema:string;section?:string;lead?:boolean;system?:boolean;ops:string[]}>; shapes: ShapeMap }` — reads `elements.json`; for each type throws if no `BUNDLED[type]` (no fallback); returns only enabled types' shapes.
  - `function reconcileElements(tasksDir: string, templatePath: string): string[]` — same shape as `reconcileRegistry` (backfill missing type keys from the template, return what was added).
- `elements.json` content = the registry block from the spec (`text/note/date/person/log`).

- [ ] **Step 1: Write the failing tests** — `loadElements` on a dir with the template `elements.json` returns shapes for all five types; `loadElements` with an unknown type key **throws** (no fallback); `reconcileElements` backfills a missing `date` key and returns `['date']`, no-op when complete.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `registry.ts` (+ template `elements.json`); extend `ensureProjectDirs`/`ensureDefaultProject` to backfill `elements.json`; call `reconcileElements` in `ProjectManager.bind` before cards are read (mirror the existing `reconcileRegistry` call + logged notice).
- [ ] **Step 4: Run — expect PASS.** Then `npx vitest run src/main/__tests__/project-manager.test.ts` (reconcile wiring intact).
- [ ] **Step 5: Commit** (`feat(elements): registry, template, boot reconciliation`).

---

### Task 8: Body serializer — elements ↔ card body

**Files:**
- Create: `src/main/tasks/elements/serialize.ts`
- Test: `src/main/__tests__/elements-serialize.test.ts`

**Interfaces:**
- Consumes: `ShapeMap`, `Element`, `mintId`.
- Produces:
  - `function bodyToElements(body: string, shapes: ShapeMap): Element[]` — operates on **`storage:'body'` shapes only** (fs shapes like `output` are materialized elsewhere, Task 9). Splits the markdown body: the block before the first `##` → the `lead` shape (omitted if blank); each `## <Section>` maps to the body-shape whose `section === Section`; each `- ` bullet (with folded continuation lines) → that shape's `parse`; any parsed `id` that is empty (hand-typed, Task 3) gets `mintId(type[0], taken)`; log section → `log` shape. An unknown section header throws (no fallback).
  - `function elementsToBody(elements: Element[], shapes: ShapeMap): string` — lead first, then one `## <section>` per non-lead/non-log shape that has elements, in `BUNDLED` order; the `## Log` header is **always emitted last, even with zero log elements**, so `appendLog`'s blind EOF append (Task 9) always lands inside it (preserves current `writeCard` behavior). Each element via its shape's `render`.

- [ ] **Step 1: Write the failing tests** — round-trip the spec's `decisiones` body (lead + Notes + Dates + People + Log) to elements and back to an equal string; **empty card** (`''` or just a lead) round-trips with no spurious sections (Review Focus); **a hand-typed id-less note line** gets an id on `bodyToElements` then stable on re-render; an **unknown `## Whatever`** section throws.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `serialize.ts`.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(elements): body serializer`).

---

### Task 9: Card refactor — `readCard`/`writeCard` via elements, derived fields, `card.v2.json`

**Files:**
- Modify: `src/main/tasks/types.ts` (Card), `src/main/tasks/files.ts` (`writeCard`, `readCard`, `appendLog`)
- Create: `src/main/tasks/schema/card.v2.json` (frontmatter: `v:2`, `id`, `title`, `status`, `created`, `due?`, `links`, `labels`)
- Modify: `src/main/tasks/validate.ts` (route `v:2` cards to `card.v2.json`)
- Test: `src/main/__tests__/files.test.ts` (extend)

**Interfaces:**
- Consumes: `bodyToElements`/`elementsToBody` (Task 8), `loadElements` shapes.
- Produces:
  - `Card` gains `elements: Element[]` and a stable `id: string`; keeps `description: string`, `notes: string[]`, `log: string[]` as **read-only derived** fields computed in `readCard` (description = lead text or `''`; notes = note elements' `data.text`; log = log elements' `data.line`).
  - `writeCard(tasksDir, card)` serializes `card.elements` via `elementsToBody` (source of truth); frontmatter written as `v:2` with a minted `id` if absent. The derived fields on the input are ignored.
  - `readCard(path)` parses frontmatter + `bodyToElements` for body elements, then appends **`storage:'fs'` elements** via each fs-shape's `materialize(tasksDir, shortname)` (so `output` elements come from `artifacts/<shortname>/`); returns `Card` with the combined `elements` + derived fields. The existing `artifacts: string[]` derived field is kept (computed from the `output` elements' `data.file`), so the snapshot/surfaces are unchanged this plan.
  - `appendLog` stays a cheap EOF append of `- <line>\n` (lands in the trailing `## Log`; re-read as a `log` element with content-id — so `diffCard`'s content dedup is unchanged).
- Note: `writeCard` needs a `ShapeMap`. Load once per card dir (cache by `tasksDir`) or pass `shapes` in; choose the minimal change that keeps `writeCard(tasksDir, card)` callers working — a module-level `shapesFor(tasksDir)` memo is acceptable.

- [ ] **Step 1: Write the failing tests** — write a card built from `elements` (lead + two notes), read it back: `elements` equal, derived `description`/`notes` correct, file has `v: 2` and an `id`; **`appendLog` then `readCard`** shows the line in derived `log` and the log element's id equals its content (Review Focus: diffCard dedup); writing a card with no elements yields a valid empty-body card.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the Card refactor, `card.v2.json`, validate routing, `writeCard`/`readCard`/`appendLog`.
- [ ] **Step 4: Run — expect PASS.** Then `npx vitest run src/main/__tests__/reconcile.test.ts src/main/__tests__/context.test.ts` (derived fields keep these green).
- [ ] **Step 5: Commit** (`feat(cards): store body as elements; derived legacy fields; card.v2`).

---

### Task 10: v1 → v2 lazy migration shim

**Files:**
- Modify: `src/main/tasks/files.ts` (`readCard` detects `v:1`)
- Create: `src/main/tasks/elements/migrate.ts`
- Test: `src/main/__tests__/elements-migrate.test.ts`

**Interfaces:**
- Produces: `function migrateV1(frontmatter, body, shapes): { front, elements }` — body-before-`## Notes` → one `text` (lead) element; `## Notes` lines `<ts> — <text>` → `note` elements (`at` = time portion of `<ts>`, fresh ids); `## Log` lines → `log` elements; frontmatter `v:1 → v:2`, mint `id` if absent; `labels`/`links` unchanged.
- `readCard` on a `v:1` file runs `migrateV1` **in memory** and returns a normal `Card`; it does **not** rewrite the file. The next `writeCard` persists v2.

- [ ] **Step 1: Write the failing tests** — a real v1 card string (the pre-refactor `## Notes`/`## Log` format) reads via `readCard` into correct `elements` + derived fields, and the on-disk file is **unchanged** (still `v:1`) after the read; a subsequent `writeCard` of the returned card produces a `v:2` file.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** `migrate.ts` + the `readCard` v1 branch.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** (`feat(cards): lazy v1→v2 migration on read`).

---

### Task 11: Element ops + rewire `note`/`describe` handlers

**Files:**
- Create: `src/main/tasks/elements/ops.ts`
- Modify: `src/main/tasks/handlers.ts` (`handleNote`, `handleDescribe`)
- Test: `src/main/__tests__/handlers.test.ts` (existing assertions must stay green), `src/main/__tests__/elements-ops.test.ts`

**Interfaces:**
- Consumes: `Element`, `ShapeMap`, `mintId`.
- Produces: `function applyOp(elements: Element[], type: string, op: string, args, shapes): Element[]` — pure; returns a new array; covers **`storage:'body'` ops only**. `note.add` appends a `note` element (fresh id, `at` = stamp, `text`); `note.edit` replaces `data.text` of the element with the given id; `note.scratch` toggles `data.scratched`; `note/date/person.drop` removes the element by id; `text.edit` replaces the lead element's `data.text` (creating the lead if absent). An `op` not in the type's `ops` throws (no fallback). **`output` (fs) ops have filesystem side effects and are wired in the surfaces/CLI follow-up** via the existing artifact endpoints; this plan materializes outputs read-only.
- `handleNote(ctx, card, text)` now does `writeCard(ctx.tasksDir, { ...card, elements: applyOp(card.elements, 'note', 'add', {text, at: stamp}, shapes) })` + `appendLog`. `handleDescribe` → `text.edit`. Observable behavior (card content, logs) unchanged — existing `handlers.test.ts` assertions pass as-is.

- [ ] **Step 1: Write the failing tests** — `elements-ops.test.ts`: `applyOp` for add/edit/scratch/drop/text.edit; an undeclared op throws. Confirm existing `handlers.test.ts` note/describe tests still assert the same card content.
- [ ] **Step 2: Run — expect FAIL** (new ops tests).
- [ ] **Step 3: Implement** `ops.ts`; rewire `handleNote`/`handleDescribe` onto it.
- [ ] **Step 4: Run — expect PASS**, then the full `handlers.test.ts` (unchanged assertions green).
- [ ] **Step 5: Commit** (`feat(elements): element ops; note/describe via ops`).

---

### Task 12: `/check` element validation + full-suite gate

**Files:**
- Modify: `src/main/tasks/validate.ts` or the `/check` handler (validate each element's `data` against its type's `schema` via the registry)
- Test: `src/main/__tests__/validate.test.ts` (extend)

**Interfaces:**
- Consumes: `loadElements`, the per-type schemas.
- Produces: `/check` validates every card against `card.v2.json` (or `v1` shim) and every element's `data` against its type schema; an element of an unknown type or failing its schema is reported (parks loud), never skipped.

- [ ] **Step 1: Write the failing test** — a card with a note missing `text` (invalid `note.v1.json`) is reported by `/check`; a card with an element of unknown type is reported.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the element-validation pass.
- [ ] **Step 4: Run — expect PASS.** Then **run the whole suite** `npx vitest run` + `npm run typecheck` — all green (regression gate for the refactor).
- [ ] **Step 5: Commit** (`feat(check): validate elements against their type schemas`).

---

## Follow-up plans (out of scope here)

- **CLI element ops** — `scratch <id>`, `edit <id> <text>`, `drop <id>` routing; element-id resolution in `CliDeps`; verb→op table. Builds on Tasks 7–11.
- **Surfaces + output ops** — snapshot ships `elements[]` + ops; board/feed render notes/dates/people/output from elements. The approved v5 note UI (regular Garamond, separated bars, double-click→`save · cancel`, resting `scratch · drop`, quiet `activity` strip, with the tighter line-height/timestamp spacing). **Agent outputs get the identical edit mechanics — double-click→editable→`save · cancel`, and `drop` — minus scratch**, wiring `output.edit`/`output.drop`/`output.add` to the existing artifact endpoints. Builds on the snapshot change.
