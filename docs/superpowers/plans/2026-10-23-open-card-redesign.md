# Open-card redesign (v5, on the element model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the expanded (open) card to render declaratively from the card's content `elements[]` in the approved v5 style, with per-element edit/save-cancel, scratch, and drop wired through a declarative element-op endpoint.

**Architecture:** The snapshot already ships `card.elements` (`{id,type,data}`); add a per-type **ops map** so the surface renders and acts declaratively. `renderOpenCard` is rewritten to draw the lead text, Notes (v5), Dates/People (when present), outputs, and a shrunk activity log from `elements`. Mutations POST to a new `/api/cards/:shortname/op` endpoint → `engine.applyElementOp` (read → `applyOp` → `writeCard`, serialized + logged). Outputs reuse the existing artifact endpoints; the legacy card-description PUT routes to `text.edit`.

**Tech Stack:** TypeScript/Node (main), vanilla-JS surfaces served over HTTP (no DOM test harness), vitest, the element model (`src/main/tasks/elements/`), EB Garamond / Lato / Menlo tokens (`surfaces/board/tokens.css`).

**Spec:** the approved v5 mockup `.superpowers/brainstorm/42808-1792665119/content/notes-v5.html` (plus v3 `grounded-v3.html` for the full card). Design decisions below are binding.

## Global Constraints (the approved v5 design — verbatim)

- **Scope: the OPEN card only** (the expanded detail). Board tiles/kanban rows are out of scope.
- **Type system:** Garamond = content (title + notes); Lato = body (description/lead); Menlo = system (meta, activity log, actions). Use the existing `tokens.css` roles/vars — no new fonts, warm paper `--paper`, accent `--accent` (#ff1055), `--radius` 6px, hairlines.
- **Notes are prose, not a checklist.** Regular-weight Garamond ~17px; **no bold.** Left hairline bars **separated by a small gap** (~5px) so adjacent bars don't touch. Line-height a touch tighter than 1.5 and the note→timestamp gap tightened (the v5 "too evenly spaced" note).
- **Note actions are WORDS, not icons.** Resting note (on hover): `scratch · drop`. **Double-click a note → inline editable field (accent ring) → `save · cancel`.** Scratched note: struck-through + muted, offers `restore · drop`.
- **Log is demoted** to a quiet collapsed `▸ activity · N` strip (Menlo, muted), expandable; it must stop reading as prose.
- **Agent outputs get the SAME edit mechanics** as notes — editable with `save · cancel`, **droppable** — but **not scratchable**.
- **Declarative/contracts:** the surface renders per `element.type` driven by the snapshot's type→ops map; it never hardcodes which ops a type has. Mutations go through the element-op endpoint → `applyOp` (no ad-hoc card writes for element content). No fallbacks / fail loud.

## Review Focus

- **A card with zero notes / empty description** → the open card renders cleanly (no empty Notes section, lead placeholder shows), and "add a note" still works. Pinned in Task 3.
- **Scratched note** round-trips the toggle through `note.scratch` and renders struck-through with `restore · drop`. Pinned in Task 4.
- **Editing a description on a card that already has a lead element** → updates the existing lead (not a no-op, not a second text element). Pinned in Task 2.
- **An element whose `type` is unknown to the surface's type map** → the render skips that element without crashing the whole card. Pinned in Task 3.
- **Concurrent note edit + SSE re-render** → an in-progress inline edit is not clobbered by a snapshot refresh (the board already defers renders while typing in an open-card field; the new note field must carry the same `[data-open-card]`/field marker). Pinned in Task 4.

---

### Task 1: Snapshot ships the element-type ops map

**Files:**
- Modify: `src/main/tasks/snapshot.ts`, `src/main/tasks/types.ts` (Snapshot)
- Modify: `src/main/server.ts` (include it in the 3 snapshot payloads next to `cardVerbs`/`open`)
- Test: `src/main/__tests__/snapshot.test.ts`

**Interfaces:**
- Produces: `Snapshot` gains `elementTypes?: Record<string, { section?: string; lead?: boolean; system?: boolean; ops: string[] }>` — the per-type config the surface needs to group/render and know allowed ops. Built **from `BUNDLED`** (each shape's `section`/`lead`/`system`/`ops`) in `BUNDLED` key order — NOT from `loadElements`/`elements.json`, so `readSnapshot` stays IO-free here and needs no `elements.json` in fixtures (consistent with the serialization-uses-BUNDLED ruling). `readSnapshot(tasksDir)` returns it; the server includes `elementTypes` in `/api/state`, `/api/events`, and `broadcast` payloads.
- Consumes: `BUNDLED` (`src/main/tasks/elements/registry.ts`).

- [ ] **Step 1: Write the failing test** — `readSnapshot(dir)` returns `elementTypes.note.ops` containing `'scratch'`, `elementTypes.text.lead === true`, `elementTypes.log.system === true`, and `elementTypes.output.ops` NOT containing `'scratch'`.
- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/main/__tests__/snapshot.test.ts`
- [ ] **Step 3: Implement** — `readSnapshot` loads the element types and attaches `elementTypes`; wire it into the server payloads (mirror the existing `cardVerbs`/`open` additions). The server test mocks must gain nothing new (it's on the readSnapshot path).
- [ ] **Step 4: Run — expect PASS**, then `npx vitest run src/main/__tests__/server.test.ts`.
- [ ] **Step 5: Commit** (`feat(snapshot): ship element-type ops map for the surfaces`).

---

### Task 2: Element-op endpoint + `engine.applyElementOp`; route description edits to `text.edit`

**Files:**
- Modify: `src/main/tasks/engine.ts` (new method), `src/main/server.ts` (new route + description routing)
- Test: `src/main/__tests__/engine.test.ts`, `src/main/__tests__/server.test.ts`

**Interfaces:**
- Produces:
  - `Engine.applyElementOp(shortname: string, type: string, op: string, args: { id?: string; text?: string }): void` — reads the card, calls `applyOp(card.elements, type, op, args, BUNDLED)` (Task-11 pure fn), `writeCard`s the result, appends a log line describing the change, refreshes facts, and `onChange()`. Throws if the card is missing or the op is undeclared (surfaces loudly).
  - `POST /api/cards/:shortname/op` with body `{ type, op, id?, text? }` → `engine().applyElementOp(...)` → `200 {ok:true}` (or 4xx on a thrown error). Broadcasts via `onChange`.
  - The existing `POST /api/cards/:shortname` description path routes a description change to `applyElementOp(shortname,'text','edit',{text})` instead of relying on `writeCard`'s create-only reconcile (so editing an existing lead works). Title stays as-is.
- Consumes: `applyOp` (`src/main/tasks/elements/ops.ts`), `BUNDLED`.

- [ ] **Step 1: Write the failing tests** — engine: `applyElementOp(card,'note','add',{text:'x'})` then `readCard` shows the note; `'note','scratch',{id}` toggles `data.scratched`; `'note','drop',{id}` removes it; `'text','edit',{text:'new'}` updates the EXISTING lead (asserts `description==='new'`, exactly one text element); an undeclared op throws. server: `POST /api/cards/c/op {type:'note',op:'add',text:'hi'}` → 200 and the note is in the card; description PUT updates an existing lead.
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the engine method + routes.
- [ ] **Step 4: Run — expect PASS**, then full `npx vitest run` + `npm run typecheck`.
- [ ] **Step 5: Commit** (`feat(engine): element-op endpoint; description edits via text.edit`).

---

### Task 3: `renderOpenCard` draws from `elements` in the v5 structure + v5 CSS

**Files:**
- Modify: `surfaces/board/cards.js` (`renderOpenCard`), `surfaces/board/board.css` (editor/notes/activity styles)
- Test: `src/main/__tests__/render-open-card.test.ts` (new — `renderOpenCard` is a pure `card → HTML string` fn; import and assert the string; add `environment: node` is fine since no DOM)

**Interfaces:**
- Consumes: the snapshot `card.elements` + `snapshot.elementTypes` (passed into the render as it already passes `highlightLabels`/`accents`).
- Produces: `renderOpenCard(card, { elementTypes, … })` HTML with: the lead `text` element as the description field; a **Notes** block of note elements in v5 markup (`data-el-id`, `data-el-type="note"`, text, a small timestamp, hover `scratch · drop` word-actions, scratched variant with `restore · drop`); **Dates/People** sections only when such elements exist; an **outputs** block; and a collapsed **`▸ activity · N`** strip for `log` elements. Unknown element types (not in `elementTypes`) are skipped, not fatal. An "add a note" affordance at the end of Notes.

- [ ] **Step 1: Write the failing test** — `renderOpenCard` for a card with a lead text + two notes (one scratched) + two log lines returns HTML that: contains both note texts, marks the scratched one (`class*="scratched"` or `data-scratched`), exposes each note's `data-el-id`, renders `activity · 2` (collapsed, not the raw log lines inline), and contains NO `## Notes` literal; a card with no notes renders no Notes section and no crash. (Review Focus: empty card; unknown type skipped.)
- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement** the render from `elements` + the v5 CSS (regular Garamond notes, 5px-gap separated left bars, tightened line-height/timestamp gap, quiet Menlo activity strip, accent edit ring styles). Keep the existing title/urgent-header/labels/footer behavior.
- [ ] **Step 4: Run — expect PASS**, then `npx vitest run`.
- [ ] **Step 5: Commit** (`feat(board): render open card from elements in v5 style`).

---

### Task 4: Note interactions — double-click edit / save · cancel, scratch, drop, add

**Files:**
- Modify: `surfaces/board/editor.js` (wire note actions), `surfaces/board/board.js` if the open-card click/dblclick delegation needs a hook
- Verify: manual in-app (surfaces have no DOM test harness) + the Task-2 endpoint tests back the behavior

**Interfaces:**
- Consumes: `renderOpenCard`'s `data-el-id`/`data-el-type` markup (Task 3); the element-op endpoint `POST /api/cards/:shortname/op` (Task 2).
- Produces: in `wireOpenCard`, delegated handlers on the Notes block —
  - **double-click a note** → swap its text for an editable field (accent ring; carry `[data-open-card]`/field marker so SSE renders defer while editing, mirroring the title/description fields) + a `save · cancel` row. `save` → `POST …/op {type:'note',op:'edit',id,text}`; `cancel` → re-render. Mirror the existing artifact `Save/Cancel` mousedown-preventDefault pattern so focus isn't lost.
  - **scratch** → `{op:'scratch',id}`; **drop** / **restore** → `{op:'drop',id}` / `{op:'scratch',id}`.
  - **add a note** → inline field → `{op:'add',text}`.
  - Actions a type doesn't declare (from `elementTypes`) are not rendered.

- [ ] **Step 1: Implement** the delegated interactions in `editor.js`, reusing the artifact save/cancel focus pattern; gate each action on the type's `ops` from `elementTypes`.
- [ ] **Step 2: Verify in-app** — `npm run dev` on a throwaway workspace: open a card, double-click a note → edit → save (persists; feed shows nothing spurious); scratch/restore toggles struck-through; drop removes; add a note appends; a mid-edit SSE refresh doesn't clobber the field.
- [ ] **Step 3: Run** `npx vitest run` + `npm run typecheck` (backend still green) and `node --check surfaces/board/editor.js`.
- [ ] **Step 4: Commit** (`feat(board): note edit/scratch/drop/add via element ops`).

---

### Task 5: Output + description interactions on the v5 card

**Files:**
- Modify: `surfaces/board/editor.js` (outputs), `surfaces/board/cards.js`/`board.css` as needed
- Verify: manual in-app + Task-2 tests

**Interfaces:**
- Consumes: Task 3 render, Task 2 endpoints, the existing artifact endpoints (`POST /api/artifacts/:card/:file`, create, delete).
- Produces: outputs rendered as elements get the **same `save · cancel` edit** (reuse the existing artifact editor) plus a **`drop`** action (delete the artifact file via its endpoint), and **no scratch**. The lead **description** edits persist via the description→`text.edit` route (Task 2) — confirm the existing contenteditable description still saves correctly under the new routing.

- [ ] **Step 1: Implement** output drop + confirm output edit uses the shared save/cancel; confirm description save routes through `text.edit`.
- [ ] **Step 2: Verify in-app** — edit an output and save; drop an output (file gone); edit the description and confirm it persists and re-reads correctly; scratch is absent on outputs.
- [ ] **Step 3: Run** `npx vitest run` + `npm run typecheck` + `node --check` the edited surfaces; then a final full-suite gate.
- [ ] **Step 4: Commit** (`feat(board): output edit/drop; description via text.edit on the v5 card`).
