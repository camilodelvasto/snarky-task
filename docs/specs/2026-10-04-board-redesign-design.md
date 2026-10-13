# taskdeck board redesign — design

**Date:** 2026-10-04
**Status:** implemented 2026-10-04 (eyes-on QA checklist pending)
**Builds on:** `docs/specs/2026-10-02-taskdeck-design.md`, `docs/specs/2026-10-03-taskdeck-cli-design.md`
**Canonical visual reference:** `.superpowers/brainstorm/34169-1791104472/content/language-sheet-v4.html` (gitignored; reproduce from the tokens below)

## Purpose

The board stops being a five-lane form-filler and becomes an editorial content surface:
cards render what they contain (a title-only card IS its title; a rich card is a post),
size signals importance, everything is reachable and editable from the keyboard, and
nothing opens a modal — cards grow in place. The language is moui.io's (paper, serif,
one hot accent) disciplined by iA restraint, spaced with Amie's air, keyed like Linear.
Fully offline: all fonts ship with the app.

## Influences (agreed)

- **iA Writer** — cleanliness; the accent used like punctuation; typing at final typography.
- **Linear** — the keyboard grammar; density discipline.
- **Amie** — spatial layout: borderless-feeling floating surfaces, generous air, small radii.
- **are.na / moui.io** — editorial restraint, serif voice, warm paper.

## Design language (sheet v4, locked)

### Fonts — vendored, offline

Copy into `surfaces/fonts/` (sources exist at
`<local font archive>/`
and `…/shapes/deck/fonts/`): `EBGaramond-Variable.woff2` (+Italic), `Lora-Variable.woff2`
(+Italic), `Lato-Regular.woff2`, `Lato-Bold.woff2`. Mono is system Menlo/Monaco (already
the feed's voice). Served by the existing static server; no network fetch, ever.

### Type scale

| role | face | size/leading | weight | tracking |
|---|---|---|---|---|
| hero title | EB Garamond | 30 / 1.14 | 640 | −0.012em |
| title | EB Garamond | 21 / 1.22 | 600 | −0.008em |
| note title | EB Garamond | 16.5 / 1.3 | 520 | 0 |
| body | Lato | 13.5 / 1.62 | 400 | 0 |
| meta (machine voice) | Menlo | 10 / 1.5 | 400 | +0.05em |
| aside / activity quotes | Lora italic | 15 / 1.5 | 450 | 0 |

Size is the importance signal: `#urgent`/`#important` → hero; posts → title; notes → note.

### Color

| token | value | role |
|---|---|---|
| `--paper` | `#faf9f7` | surface background |
| `--card` | `#ffffff` | floating card |
| `--ink` | `#1c1c18` | primary text |
| `--ink-2` | `#52524c` | body/secondary |
| `--ink-3` | `#8a8a82` | meta |
| `--ink-4` | `#c8c8c2` | faintest (note meta) |
| `--accent` | `#ff1055` | THE accent |
| `--grad` | `128deg #ff1055 → #ff5c2e → #ffb03d` (rotations vary) | urgent/important cards only |
| `--edge-grad` | `90deg #ff1055 → #E5F20D` | active card bottom edge |

**Accent discipline (iA rule): exactly four uses** — focus ring, text caret, active card
bottom edge, one-word text actions. Never backgrounds, never decoration.
**Gradient discipline:** full-bleed gradients belong ONLY to cards labeled `urgent` or
`important`. Rotation varies per card (hash shortname → one of 4 preset rotations in the
pink→orange→yellow family) so no two match. Dark mode: tokens make it possible; a dark
palette is deferred, not designed here.

### Containment ladder (borders)

- **flat** (notes, rail items): no border, no shadow; hover = tone (`--paper`→`--card`).
- **floating** (post cards): whisper border `1px rgba(15,15,12,.055)` + two-layer shadow
  `0 1px 2px rgba(15,15,12,.04), 0 6px 20px rgba(15,15,12,.05)`.
- **fields** (editable, when a card is open): functional border `1px rgba(15,15,12,.09)`,
  no shadow; focus replaces it with the accent ring (2px, offset 2).
- **urgent**: borderless, floats on its own colored shadow (`rgba(255,16,85,.15/.18)`).

Hairlines (`#e8e8e4`) exist only inside an open card, dividing its sections.

### Space & shape

4px grid. Radius **6px everywhere** (subtle, never round). Card padding 22/24; card gap
24; surface margin 28. Masonry via CSS columns (2 cols ≥ 900px pane, 1 below; 3 ≥ 1400px).

### Motion

150–250ms, `cubic-bezier(0.16, 1, 0.3, 1)`, opacity+transform only (Rauno's rules).
Card grow-in-place: 240ms. Hover: shadow deepens ≤ 1 step; no scaling, no translateY
larger than 1px. The FLIP technique already used for column moves extends to grow/shrink.

## Zones & view modes

Pure presentation over the untouched five-status model (files, engine, CLI unchanged):

| zone | statuses | where |
|---|---|---|
| **surface** | `active` | masonry, main area |
| **backlog** | `inbox`, `waiting` | narrow right rail (~200px); `waiting` carries a mono `waiting · <due>` mark |
| **archive** | `done`, `dropped` | separate view (`⇧A`), grouped by completion date — accountability, not workspace |

**Rail language:** the rail rhymes with the feed (terminal voice): flat rows, Garamond
note-size titles, mono meta; no boxes, no size games. Hover = tone only.

**Modes** (`1/2/3`, persisted in localStorage — screen taste, not task truth):
1. **surface** (default) — masonry + rail as above.
2. **columns** — the existing five-column kanban, restyled to this language (cards use the
   same note/post anatomy; columns keep drag-and-drop).
3. **list** — dense single-column rows (Linear-ish): pill-less status mark, title, meta
   right-aligned; same keyboard grammar.

Archive is reachable from any mode; it renders list-style with completion stamps.

## Card anatomy

- **note** (no description, no artifacts, log = creation only): bare title on the paper +
  faintest mono meta (due/date). No container at all.
- **post**: floating card — title, body (description, clamped ~4 lines when closed),
  mono meta line (status · artifacts · last activity). Active posts get the full-width
  2px gradient bottom edge (inside the 6px radius via overflow hidden).
- **urgent/important** (label-driven): gradient card, white text, hero or title scale.
- A card promotes note→post the moment it gains content; no empty sections ever render.

## Interaction model

### Keyboard (Linear grammar)

| key | action |
|---|---|
| `↑↓←→` | move focus between cards (roving tabindex; visible accent ring) |
| `⏎` | grow focused card in place |
| `esc` | shrink card / blur field (field-first) |
| `tab` | next field inside an open card (title → description → close cycle) |
| `e` | open + focus title directly |
| `a` | activate (rail → surface; the card grows out of the rail, Family-style continuity) |
| `b` | send to backlog (inbox) |
| `d` / `x` | done / drop — both emit queue instructions; drop keeps the confirmation gate |
| `⌘⏎` | save & shrink |
| `1/2/3` | surface / columns / list |
| `⇧A` | archive view |

`x` deletes the card file (after the confirmation gate) — it does not set status `dropped`; `dropped` is reached by language/CLI moves.

Mouse keeps parity (click = focus, click again / dblclick = grow; drag works in columns
mode). Every keyboard mutation emits a **pre-resolved instruction** through the queue —
the same door as drag-drop; the feed shows each one with `›_`.

### Grow-in-place (no modals)

The focused card animates its own box (FLIP, 240ms) to an editing width (min(640px, pane−56))
while neighbors reflow; the paper does not dim, nothing overlays. Open state adds, in
order: title (editable), description (editable, grows with content), meta line, activity
(Lora italic timestamp rows, collapsed to last 3 with a mono "+n more"), artifacts list.
`esc`/`⌘⏎` shrinks it back into its masonry slot.

### Typing at final typography

Fields are `contenteditable` (plain text only — paste sanitized to text) styled exactly
as the rendered card: the title edits at Garamond 21/30, the description at Lato 13.5.
No input chrome beyond the field border rung and accent caret. Description accepts
newlines; markdown remains plain text in v1 (no rendering — honest non-goal).

## Doors (engine/API deltas — the only non-surface work)

1. **Title edit**: `POST /api/cards/:shortname` accepts `{ title }` alongside
   `{ description }`. The reconciler (`reconcile.ts`) adds `title` to its watched facts and
   logs `title edited (direct edit)` — same contract as status/description today.
2. **Keyboard state moves**: `a/b/d/x` POST pre-resolved instructions
   (`update_status`/`delete` with `action/card/to` frontmatter) — mechanism already exists.
3. **Labels**: `urgent`/`important` are ordinary labels set via CLI (`#urgent`) or
   language; no new label API.

Nothing else: no schema, registry, resolver, or CLI changes.

## Out of scope (v1)

- Dark palette (tokens permit it; design deferred).
- Markdown rendering in descriptions.
- Feed (left pane) redesign — it already speaks its language; only the rail quotes it.
- Reordering within the surface (masonry orders by: urgent/important first, then last
  activity desc; not user-sortable yet).
- Multi-select, bulk actions.

## Testing

- Engine/API deltas (title door, reconciler title tracking): vitest, TDD as usual.
- Surfaces remain test-free vanilla JS; verification is a manual checklist per mode:
  keyboard walk, grow/shrink, inline edit round-trip (file frontmatter confirms), note→post
  promotion, urgent gradient variation, rail activate animation, archive grouping, offline
  cold start (network disabled), `npx eslint surfaces/` clean.
- The implementation plan must include a visual QA pass against sheet v4 tokens
  (spot-check: type sizes, shadow values, accent-use audit — exactly four).
