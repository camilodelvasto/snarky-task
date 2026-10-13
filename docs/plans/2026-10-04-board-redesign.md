# taskdeck Board Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the board's kanban-form look with the spec'd editorial surface: masonry of content-adaptive cards + backlog rail, full keyboard grammar, grow-in-place editing — plus the two engine doors (title edit, reconciler title tracking).

**Architecture:** The board surface is rebuilt as vanilla ES modules (`board.js` entry + `cards.js` render + `keyboard.js` focus/keys + `editor.js` grow-in-place), all styled from a single `tokens.css` carrying the locked sheet-v4 language. Fonts are vendored under `surfaces/fonts/` and served by a new `/fonts` route. All state mutations flow through existing doors: pre-resolved queue instructions for status moves, the card POST (extended with `title`) for edits.

**Tech Stack:** Vanilla JS (ES modules, no build step), CSS, TypeScript main process (vitest TDD for server/reconciler deltas).

**Spec:** `docs/specs/2026-10-04-board-redesign-design.md` — the executor must read it; every visual value below is defined there.

## Global Constraints

- Fonts are LOCAL ONLY (`surfaces/fonts/*.woff2`); no network fetch anywhere; app must cold-start offline.
- Type scale (exact): hero EB Garamond 30/1.14 w640 ls-0.012em · title 21/1.22 w600 ls-0.008em · note 16.5/1.3 w520 · body Lato 13.5/1.62 · meta Menlo 10 ls+0.05em · aside Lora italic 15.
- Colors (exact): paper `#faf9f7`, card `#fff`, ink `#1c1c18`, ink-2 `#52524c`, ink-3 `#8a8a82`, ink-4 `#c8c8c2`, accent `#ff1055`, edge gradient `90deg #ff1055→#E5F20D`, urgent gradients 128deg in the `#ff1055→#ff5c2e→#ffb03d` family (4 preset rotations, hash-picked).
- Accent appears in EXACTLY four uses: focus ring, caret, active bottom edge, one-word text actions. Nothing else.
- Full-bleed gradients ONLY on cards labeled `urgent` or `important`.
- Containment ladder: flat (no border/shadow; hover tone) · floating (border `1px rgba(15,15,12,.055)` + shadow `0 1px 2px rgba(15,15,12,.04), 0 6px 20px rgba(15,15,12,.05)`) · fields (border `1px rgba(15,15,12,.09)`, no shadow) · urgent (borderless, shadow `0 1px 2px rgba(255,16,85,.15), 0 8px 24px rgba(255,16,85,.18)`).
- Radius 6px everywhere. 4px spacing grid: card padding 22/24, gap 24, surface margin 28. Hairlines `#e8e8e4` only inside an open card.
- Motion: 150–250ms, `cubic-bezier(0.16,1,0.3,1)`, opacity/transform only; grow-in-place 240ms; hover never scales or lifts > 1px.
- Zones: surface=`active`, rail=`inbox`+`waiting`, archive=`done`+`dropped`. The five-status model, files, engine pipeline, and CLI are UNCHANGED except the two doors in Task 2.
- Every keyboard mutation emits a pre-resolved instruction (`POST /api/instructions` with `text` + `action/card/to`), never a direct card write; title/description edits go through `POST /api/cards/:shortname`.
- `npm run typecheck && npx eslint . && npx vitest run` green before every commit. Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Structure

```
surfaces/fonts/                     # NEW: vendored woff2 (EBGaramond, Lora ×2, Lato ×2)
surfaces/board/index.html           # rewritten shell: topbar(mode tabs) + #surface + #rail, module script
surfaces/board/tokens.css           # NEW: @font-face + all sheet-v4 tokens (type, color, ladder, motion)
surfaces/board/board.css            # rewritten: components for surface/rail/columns/list/archive + editor
surfaces/board/board.js             # rewritten entry: state, SSE, mode router, render dispatch
surfaces/board/cards.js             # NEW: pure render fns (note/post/urgent anatomy, gradient hash, zones)
surfaces/board/keyboard.js          # NEW: roving focus, key grammar, instruction emission
surfaces/board/editor.js            # NEW: FLIP grow/shrink, contenteditable fields, save doors
src/main/server.ts                  # /fonts route + woff2 MIME + card POST accepts title
src/main/tasks/reconcile.ts         # CardFacts + diffCard gain title
src/main/tasks/engine.ts            # refreshCardFacts/reconcileCard carry title
```

---

### Task 1: Fonts vendored + served; tokens.css

**Files:**
- Create: `surfaces/fonts/` (5 files copied), `surfaces/board/tokens.css`
- Modify: `src/main/server.ts` (CONTENT_TYPES + fonts route), `surfaces/board/index.html` (link tokens.css)
- Test: `src/main/__tests__/server.test.ts`

**Interfaces:**
- Produces: GET `/fonts/<file>` serves from `surfaces/fonts/` with `font/woff2`; CSS custom properties consumed by every later task: `--paper --card --ink --ink-2 --ink-3 --ink-4 --accent --hairline --radius --shadow-float --border-float --border-field --shadow-urgent --ease --dur --dur-grow --edge-grad` and font families `garamond`, `lora`, `lato`.

- [ ] **Step 1: Copy fonts**

```bash
mkdir -p surfaces/fonts
F=<local font archive>
cp $F/eb-garamond/EBGaramond-Variable.woff2 $F/eb-garamond/EBGaramond-VariableItalic.woff2 \
   $F/lora/Lora-Variable.woff2 $F/lora/Lora-VariableItalic.woff2 \
   $F/lato/Lato-Regular.woff2 $F/lato/Lato-Bold.woff2 surfaces/fonts/
```

- [ ] **Step 2: Write the failing server test** — add to `src/main/__tests__/server.test.ts` (follow that file's existing request-helper pattern for GETs):

```ts
it('serves vendored fonts with the woff2 mime type', async () => {
  const res = await get('/fonts/EBGaramond-Variable.woff2')
  expect(res.status).toBe(200)
  expect(res.headers['content-type']).toBe('font/woff2')
})
it('rejects font path traversal', async () => {
  const res = await get('/fonts/../board/board.js')
  expect([400, 403, 404]).toContain(res.status)
})
```

(The test harness serves from a temp surfacesDir — create `fonts/EBGaramond-Variable.woff2` with dummy bytes in the fixture setup, same way the fixture creates `feed/`/`board/` files.)

- [ ] **Step 3: Run, verify FAIL** — `npx vitest run server` → 404 route missing.
- [ ] **Step 4: Implement** — in `server.ts`: add `'.woff2': 'font/woff2'` to `CONTENT_TYPES`; next to the feed/board matchers add:

```ts
const fontsMatch = pathname.match(/^\/fonts(\/.*)?$/)
if (fontsMatch) {
  serveStatic(res, 'fonts', fontsMatch[1] ?? '/')
  return
}
```

(`serveStatic` already joins `surfacesDir` + name and guards traversal; `fonts/` sits beside `feed/` and `board/` under `surfacesDir`, so no other change.)

- [ ] **Step 5: Run, verify PASS**, full gate.
- [ ] **Step 6: Write `surfaces/board/tokens.css`** (values verbatim from Global Constraints):

```css
@font-face { font-family: garamond; src: url('/fonts/EBGaramond-Variable.woff2') format('woff2'); font-weight: 100 900; font-display: swap; }
@font-face { font-family: garamond; src: url('/fonts/EBGaramond-VariableItalic.woff2') format('woff2'); font-weight: 100 900; font-style: italic; font-display: swap; }
@font-face { font-family: lora; src: url('/fonts/Lora-Variable.woff2') format('woff2'); font-weight: 100 900; font-display: swap; }
@font-face { font-family: lora; src: url('/fonts/Lora-VariableItalic.woff2') format('woff2'); font-weight: 100 900; font-style: italic; font-display: swap; }
@font-face { font-family: lato; src: url('/fonts/Lato-Regular.woff2') format('woff2'); font-weight: 400; font-display: swap; }
@font-face { font-family: lato; src: url('/fonts/Lato-Bold.woff2') format('woff2'); font-weight: 700; font-display: swap; }

:root {
  --paper: #faf9f7; --card: #ffffff;
  --ink: #1c1c18; --ink-2: #52524c; --ink-3: #8a8a82; --ink-4: #c8c8c2;
  --accent: #ff1055; --hairline: #e8e8e4;
  --radius: 6px;
  --border-float: 1px solid rgba(15, 15, 12, 0.055);
  --border-field: 1px solid rgba(15, 15, 12, 0.09);
  --shadow-float: 0 1px 2px rgba(15, 15, 12, 0.04), 0 6px 20px rgba(15, 15, 12, 0.05);
  --shadow-urgent: 0 1px 2px rgba(255, 16, 85, 0.15), 0 8px 24px rgba(255, 16, 85, 0.18);
  --edge-grad: linear-gradient(90deg, #ff1055, #e5f20d);
  --ease: cubic-bezier(0.16, 1, 0.3, 1);
  --dur: 180ms; --dur-grow: 240ms;
  --mono: 10px/1.5 Menlo, Monaco, monospace;
}
/* type roles */
.t-hero  { font: 640 30px/1.14 garamond, serif; letter-spacing: -0.012em; }
.t-title { font: 600 21px/1.22 garamond, serif; letter-spacing: -0.008em; }
.t-note  { font: 520 16.5px/1.3 garamond, serif; }
.t-body  { font: 400 13.5px/1.62 lato, sans-serif; color: var(--ink-2); }
.t-meta  { font: var(--mono); letter-spacing: 0.05em; color: var(--ink-3); }
.t-aside { font: italic 450 15px/1.5 lora, serif; color: var(--ink-2); }
```

- [ ] **Step 7: Link it** — in `surfaces/board/index.html` add `<link rel="stylesheet" href="/board/tokens.css" />` before `board.css`. Reload board view; in devtools confirm the woff2 requests return 200 from localhost only.
- [ ] **Step 8: Commit** — `git add -A && git commit -m "feat: vendored fonts + /fonts route + board design tokens"`

---

### Task 2: Title door + reconciler title tracking (TDD)

**Files:**
- Modify: `src/main/server.ts` (card POST), `src/main/tasks/reconcile.ts`, `src/main/tasks/engine.ts` (two `cardFacts` sites)
- Test: `src/main/__tests__/server.test.ts`, `src/main/__tests__/reconcile.test.ts`, `src/main/__tests__/engine.test.ts`

**Interfaces:**
- Produces: `POST /api/cards/:shortname` body may carry `{ title?: string, description?: string }` (either or both; still `{ action: 'delete' }` alternatively). `CardFacts` = `{ status, description, title }`; `diffCard` emits `` `title edited (direct edit)` ``.

- [ ] **Step 1: Failing tests.** server.test.ts (mirror the existing description-save test):

```ts
it('card POST updates title through the door', async () => {
  // fixture: write card 'x' with title 'Old' via writeCard, then:
  const res = await post('/api/cards/x', { title: 'New title' })
  expect(res.status).toBe(200)
  expect(readCard(join(tasksDir, 'cards', 'x.md')).title).toBe('New title')
})
```

reconcile.test.ts:

```ts
it('reports a direct title edit', () => {
  expect(
    diffCard(
      { status: 'inbox', description: 'x', title: 'A' },
      { status: 'inbox', description: 'x', title: 'B' }
    )
  ).toEqual(['title edited (direct edit)'])
})
```

Also update the existing `diffCard` tests' fixtures to include `title` (same value both sides).
engine.test.ts — extend the existing 'logs status and description changes' test: hand-edit the title too and assert the third log line appears once.

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — `reconcile.ts`: add `title: string` to `CardFacts`; in `diffCard` append `if (prev.title !== next.title) changes.push('title edited (direct edit)')` (order: status, title, description — match test expectations). `engine.ts`: both `cardFacts.set(...)` sites add `title: c.title`. `server.ts` card POST: accept `title`:

```ts
if (body.description !== undefined || body.title !== undefined) {
  // existing existsSync guard …
  const card = readCard(cardPath)
  writeCard(tasksDir, {
    ...card,
    ...(body.title !== undefined ? { title: body.title } : {}),
    ...(body.description !== undefined ? { description: body.description } : {})
  })
  json(res, 200, { ok: true })
  return
}
```

Reject empty titles: `if (body.title !== undefined && !body.title.trim()) { json(res, 400, { error: 'title cannot be empty' }); return }`.

- [ ] **Step 4: Run, verify PASS**; full gate. **Step 5: Commit** — `"feat: title edit door + reconciler title tracking"`

---

### Task 3: Card anatomy + surface view (render only)

**Files:**
- Create: `surfaces/board/cards.js`
- Rewrite: `surfaces/board/board.js`, `surfaces/board/board.css`, `surfaces/board/index.html`
- (Columns-mode markup from the old board.js is preserved inside board.js as `renderColumns` — restyled in Task 6.)

**Interfaces:**
- Consumes: tokens.css classes/vars (Task 1).
- Produces (from `cards.js`): `cardKind(c) → 'note'|'post'`, `importance(c) → 'hero'|'title'|'note'`, `gradientFor(shortname) → css-gradient-string`, `isUrgent(c) → bool` (labels include `urgent` or `important`), `renderCard(c, {zone}) → html`, `renderRailItem(c) → html`. From `board.js`: `state = { snapshot, mode, focusIdx, openCard }`, `rerender()`, `els() → NodeList of [data-card]` — consumed by Tasks 4–5.

- [ ] **Step 1: `cards.js`** — pure functions, no DOM access:

```js
const GRADS = [
  'linear-gradient(128deg,#ff1055 6%,#ff5c2e 60%,#ffb03d 112%)',
  'linear-gradient(128deg,#ff1055 0%,#ff7a3d 70%,#e5a50d 120%)',
  'linear-gradient(118deg,#d40d47 0%,#ff5c2e 55%,#ffb03d 105%)',
  'linear-gradient(138deg,#ff1055 10%,#ff4733 65%,#f2a007 115%)'
]
export const isUrgent = (c) => c.labels.some((l) => l === 'urgent' || l === 'important')
export const cardKind = (c) =>
  !c.description && c.artifacts.length === 0 && c.log.length <= 1 ? 'note' : 'post'
export const importance = (c) => (isUrgent(c) ? 'hero' : cardKind(c) === 'post' ? 'title' : 'note')
export function gradientFor(shortname) {
  let h = 0
  for (const ch of shortname) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return GRADS[h % GRADS.length]
}
```

`renderCard(c, {zone})`: note → `<article class="card note" data-card="${shortname}"><h3 class="t-note">title</h3><div class="t-meta m-faint">due|created</div></article>`; post → floating article with `t-title|t-hero` title, clamped body (`<p class="t-body clamp">description</p>` only when non-empty), meta line `status · n artifacts · hh:mm` (last log time), class `active-edge` when `c.status==='active'`, class `urgent` + inline `style="background:${gradientFor(...)}"` when urgent. All text through the existing `esc()` (move `esc` into cards.js and export it). No empty elements ever emitted.
`renderRailItem(c)`: flat row — `t-note` title + `t-meta` (`waiting · due` when status waiting, else created date).

- [ ] **Step 2: `board.js` rewrite** — keep: SSE wiring, `/api/state` bootstrap, pendingMoves/displayStatus logic (now mapping into zones), drag-drop handlers (operative again in Task 6's columns mode; harmless listeners meanwhile). New core:

```js
import { renderCard, renderRailItem, esc } from './cards.js'
export const state = { snapshot: { cards: [], instructions: [] }, mode: localStorage.getItem('td-mode') ?? 'surface', focusIdx: 0, openCard: null }
const zones = (cards) => ({
  surface: cards.filter((c) => c.status === 'active'),
  rail: cards.filter((c) => c.status === 'inbox' || c.status === 'waiting'),
  archive: cards.filter((c) => c.status === 'done' || c.status === 'dropped')
})
export function rerender() { /* dispatch on state.mode: renderSurface | renderColumns | renderList | renderArchive */ }
```

`renderSurface`: surface ordered urgent-first then by last-activity desc; masonry container + rail; topbar tabs `surface columns list · archive` with the active one marked.

- [ ] **Step 3: `board.css` rewrite** — components on top of tokens: `.surface { column-count:2; column-gap:24px; padding:28px; }` (`@media (min-width:1400px){ column-count:3 }`, `@media (max-width:900px){ column-count:1 }`); `.card { break-inside:avoid; margin-bottom:24px; border-radius:var(--radius); transition: box-shadow var(--dur) var(--ease); }`; `.card.post { background:var(--card); border:var(--border-float); box-shadow:var(--shadow-float); padding:22px 24px; position:relative; overflow:hidden; }`; `.card.note { padding:6px 2px; }` (flat rung — no border/shadow; hover background `var(--card)`); `.active-edge::after { content:''; position:absolute; inset:auto 0 0 0; height:2px; background:var(--edge-grad); }`; `.urgent { border:none; box-shadow:var(--shadow-urgent); color:#fff; }` (+ descendant text colors per sheet); `.rail { width:200px; … flat rows }`; `.clamp { display:-webkit-box; -webkit-line-clamp:4; -webkit-box-orient:vertical; overflow:hidden; }`; topbar mono tabs with accent underline on the active tab (one-word action rule). Remove every rule the old design needed (pills in columns stay for Task 6 restyle; keep the file lean — port only what columns mode still uses into a clearly-marked `/* columns mode (restyled task 6) */` block).
- [ ] **Step 4: `index.html` rewrite** — topbar + `<main id="surface-root"></main>`; `<script type="module" src="/board/board.js"></script>`. Verify in the app: masonry renders, notes are bare, urgent cards gradient-vary, active edge full-width, rail lists inbox/waiting. Board no longer opens any detail (editor arrives in Task 5) — expected intermediate state, note it in the commit body.
- [ ] **Step 5: `npx eslint surfaces/` clean; commit** — `"feat: board surface view — note/post anatomy, urgent gradients, backlog rail"`

---

### Task 4: Keyboard grammar + instruction emission

**Files:**
- Create: `surfaces/board/keyboard.js`
- Modify: `surfaces/board/board.js` (wire after rerender), `surfaces/board/board.css` (focus ring)

**Interfaces:**
- Consumes: `state`, `rerender`, `els()` from board.js; Task 5 consumes `onOpen(cb)` hook it registers.
- Produces: `initKeyboard({ onOpen })`; `emitInstruction(text, resolved)` →

```js
export function emitInstruction(text, resolved) {
  return fetch('/api/instructions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...resolved })
  })
}
```

- [ ] **Step 1: Focus model** — roving tabindex over `[data-card]` in DOM order (masonry columns read top-to-bottom then next column — acceptable v1; arrows ←→ jump by column via `getBoundingClientRect` nearest-x heuristic, ↑↓ within column). Focus ring: `.card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }` — rail items included.
- [ ] **Step 2: Keys** — single `keydown` listener on the board root, inert while `editor.isOpen()` (field-first `esc` handled by editor):

```js
const KEYMAP = {
  a: (c) => emitInstruction(`move #${c.shortname} to active`, { action: 'update_status', card: c.shortname, to: 'active' }),
  b: (c) => emitInstruction(`move #${c.shortname} to inbox`, { action: 'update_status', card: c.shortname, to: 'inbox' }),
  d: (c) => emitInstruction(`move #${c.shortname} to done`, { action: 'update_status', card: c.shortname, to: 'done' }),
  x: (c) => emitInstruction(`delete #${c.shortname}`, { action: 'delete', card: c.shortname })
}
```

plus `Enter`/`e` → `onOpen(card, { editTitle: key === 'e' })`; `1/2/3` → mode set + localStorage + rerender; `Shift+A` → archive mode. Focus follows the card across zone changes by shortname (recompute focusIdx after SSE rerender).
- [ ] **Step 3: Manual verify** — full keyboard walk per spec table; `x` parks at needs_confirmation (feed shows it; confirm there). **Step 4: lint + commit** — `"feat: board keyboard grammar — roving focus, zone moves via queue instructions"`

---

### Task 5: Grow-in-place editor

**Files:**
- Create: `surfaces/board/editor.js`
- Modify: `surfaces/board/board.js` (register onOpen), `surfaces/board/board.css` (open-state styles)

**Interfaces:**
- Consumes: `state`, `rerender`, card POST door (Task 2), `emitInstruction` (Task 4).
- Produces: `isOpen()`, `open(card, {editTitle})`, `close({save})` — used by keyboard.js.

- [ ] **Step 1: FLIP grow** — `open(card)`: record the card element's rect (First), add `.open` class (card gets `column-span:all`-free approach: position the open card with `width:min(640px, calc(100% - 56px))` via a measured absolute placement inside the scroll container to avoid masonry reflow jumps — simpler robust v1: the open card becomes `position:fixed`-free **in-flow block above the masonry** — move the card element to a dedicated `#open-slot` div above the columns container, animate from the recorded rect to the new rect (Invert+Play, `--dur-grow`, `var(--ease)`), masonry reflows beneath). `close()` reverses to the (re-measured) slot.
- [ ] **Step 2: Open-state content** — rebuild innerHTML in open mode: title (`contenteditable="plaintext-only"`, class from importance), description (`contenteditable="plaintext-only"` `.t-body`, placeholder shown via `:empty::before { content:'add context…'; color:var(--ink-4) }` — placeholder text is NOT saved), hairline, meta line, activity (last 3 `t-aside` rows + mono `+n more` toggle), artifacts (mono rows), hairline, one-word text actions in mono (`close · done · drop` — accent on hover only). Fields wear the field-rung border on focus-within.
- [ ] **Step 3: Keys inside** — `tab` cycles title→description→close-action; `esc` blurs field first, second `esc` closes without save; `⌘⏎` saves both fields then closes. Save = `POST /api/cards/:s` with changed fields only; skip POST when unchanged; empty title → restore previous (door rejects it anyway).
- [ ] **Step 4: Paste sanitize** — on `paste` in either field: `e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain'))`.
- [ ] **Step 5: Mouse parity** — click focuses; click on focused card opens. **Step 6: verify round-trip** — edit title, `⌘⏎`, `cat` the card file: frontmatter title changed, log shows `title edited (direct edit)`. **Step 7: lint + commit** — `"feat: grow-in-place editor — contenteditable at final typography, door writes"`

---

### Task 6: Columns, list, archive modes

**Files:**
- Modify: `surfaces/board/board.js` (renderColumns/renderList/renderArchive), `surfaces/board/board.css`

**Interfaces:**
- Consumes: everything prior; drag-drop handlers retained from old board.js.

- [ ] **Step 1: Columns mode** — five columns, headers in mono (`inbox · n` style, no dots/badges), cards via `renderCard` (same anatomy, narrower); drag-drop + optimistic pendingMoves kept exactly as today (listeners already in board.js).
- [ ] **Step 2: List mode** — dense rows: 2px status square (status-colored: reuse column accents), `t-note` title, right-aligned `t-meta` (due · artifacts · hh:mm); same focus/keys; Enter opens the same editor (opens above the list).
- [ ] **Step 3: Archive mode** — `done`+`dropped` grouped by last-log date desc, group headers `t-meta`; rows list-style with `done`/`dropped` stamp; read-only except `a` (reactivate) and `x`.
- [ ] **Step 4: Mode routing** — topbar tabs clickable; `1/2/3/⇧A` already wired; localStorage round-trip verified. **Step 5: lint + commit** — `"feat: columns, list, archive modes in the new language"`

---

### Task 7: QA pass + docs

**Files:**
- Modify: `CLAUDE.md` (Surfaces section: zones, modes, keyboard map 6 lines), `docs/specs/2026-10-04-board-redesign-design.md` (mark Status: implemented)

- [ ] **Step 1: Accent audit** — `grep -n "ff1055\|--accent" surfaces/board/*.css surfaces/board/*.js`: every hit must be one of the four permitted uses; fix any stray.
- [ ] **Step 2: Offline cold start** — quit app, disable network (or `sudo ifconfig en0 down`/toggle Wi-Fi), start `npm run dev`: board renders with correct fonts (devtools: all font requests from 127.0.0.1, zero external requests on either surface).
- [ ] **Step 3: Manual checklist** (spec Testing section) — keyboard walk all modes; grow/shrink timing feel; note→post promotion (add description to a note via editor, card re-renders as post); urgent gradient variation across ≥3 labeled cards; rail `a` activation continuity; archive grouping; drag-drop in columns mode; feed still green (`›_` rows for every keyboard mutation).
- [ ] **Step 4: Full gate + docs + commit** — `"feat: board redesign QA + docs"`
