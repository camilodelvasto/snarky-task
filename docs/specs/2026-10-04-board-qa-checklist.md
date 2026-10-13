# taskdeck board redesign — QA checklist

**Date:** 2026-10-04  
**Verified by:** eyes-on manual walk

## Environment setup

- [ ] Quit the app entirely and close DevTools
- [ ] Disable network: `sudo ifconfig en0 down` (or WiFi toggle)
- [ ] `npm run dev` — app starts cleanly at `127.0.0.1:7920/board`
- [ ] DevTools Network tab: all font requests from `127.0.0.1:7920` (same server), zero external requests (googleapis, CDNs, etc.)
- [ ] Re-enable network after

## Surface mode walk

### Mode 1: Surface (masonry + rail)

- [ ] Default mode on load
- [ ] Press `1` — confirms masonry view active
- [ ] Masonry: 2 columns ≥900px, 1 column <900px; observe window resize behavior
- [ ] Right rail: backlog items (`inbox`, `waiting`) render flat (no boxes)
- [ ] `waiting` items show mono metadata: `waiting · <due date>`
- [ ] Rail hover: background tone only (no shadow, no scale)
- [ ] Archive not visible; press `⇧A` to enter archive view

### Mode 2: Columns (5-lane kanban)

- [ ] Press `2` — switches to 5-column view
- [ ] Columns labeled (left to right): status names from config
- [ ] Cards retain note/post anatomy; grow-in-place still works
- [ ] Drag card between columns — observe smooth animation (FLIP technique)
- [ ] Drag a card, watch feed populate with `›_` queue entry (pre-resolved instruction)
- [ ] Close app, restart, confirm view mode persisted (localStorage `td-mode`; column order is fixed)

### Mode 3: List

- [ ] Press `3` — single-column dense list view
- [ ] Each row: pill-less status mark (color dot?), title, meta right-aligned
- [ ] Same keyboard and grow-in-place behavior as other modes
- [ ] Scroll performance with many cards

### Archive view

- [ ] Press `⇧A` from any mode — archive view appears
- [ ] Cards grouped by completion date (most recent first)
- [ ] Date headers visible (e.g., "2026-10-03")
- [ ] List-style rendering (same as mode 3 layout)
- [ ] Press `⇧A` again or `esc` to return to previous mode

## Keyboard navigation

### Movement & focus

- [ ] `↑` — move focus up (previous card in reading order)
- [ ] `↓` — move focus down (next card)
- [ ] `←` — move focus left (previous column in columns mode; no-op in masonry/list)
- [ ] `→` — move focus right (next column in columns mode; no-op in masonry/list)
- [ ] Focus always shows 2px accent outline (`:focus-visible`, `#ff1055`)

### Grow & edit

- [ ] Focus a card, press `⏎` — card grows in place (FLIP, 240ms ease-out)
- [ ] Neighbors reflow smoothly; paper does NOT dim, no modal overlay
- [ ] Grown card shows (in order): title (editable), description (editable), meta line (read-only), activity (collapsed)
- [ ] `esc` shrinks card back to original slot
- [ ] `⌘⏎` saves changes and shrinks
- [ ] Title edit: press `e` while focused (grows card, focuses title field)
  - Type new title, press `⌘⏎` or `tab` to move to description
  - `esc` to cancel without saving
  - Verify card file frontmatter updated: `cat workspace/tasks/cards/<shortname>.md`
  - Verify log entry: `title edited (direct edit)` appears in activity

### Title editing (direct and via grow)

- [ ] Title field: `contenteditable`, border 1px functional (`rgba(15,15,12,.09)`), focus ring replaces border
- [ ] Caret color: accent (`#ff1055`)
- [ ] Paste sanitized to plain text (test: copy rich text, paste into title)
- [ ] Card promotes note→post if description gained content (no empty sections render)

### Description editing

- [ ] Description field: accepts newlines, `contenteditable` plain text
- [ ] Styled at Lato 13.5/1.62 (same as card body when closed)
- [ ] Focus ring on description: 2px accent
- [ ] Submit changes: `⌘⏎` or `tab` to next field (meta line is read-only, cycles back to title)
- [ ] Close card, reopen — description persists, markdown remains plain text (no rendering)

### Zone moves via queue

- [ ] Focus a card, press `a` (activate) — card moves from backlog rail to surface
  - Verify smooth animation (Family-style continuity, card "grows out" of rail)
  - Verify feed shows `›_` queue entry: `update_status` to active
  - Verify card file frontmatter: `status: active` set
- [ ] Focus a surface card, press `b` (backlog) — moves to inbox on rail
  - Verify feed shows `›_ update_status inbox`
- [ ] Focus a card, press `d` (done) — card moves to done
  - No confirmation gate (immediate)
  - Feed shows `›_ update_status done`
- [ ] Focus a card, press `x` (delete) — confirmation gate appears in feed (needs_confirmation)
  - Approve: card file is deleted (not moved to dropped); feed clears queue entry
  - Reject: card stays; feed clears queue entry

## Note → Post promotion

- [ ] Create a note card (title only, no description)
- [ ] Verify rendering: title on paper, no container, faintest mono meta
- [ ] Grow the card (`⏎`), add description text
- [ ] Shrink card (`⌘⏎`) — observe re-render as floating post (whisper border, shadow)
- [ ] Grow again — full anatomy visible (title, body, meta, activity)

## Urgent/Important labels & gradients

- [ ] Create ≥3 cards, label them `#urgent` or `#important`
- [ ] Each urgent/important card renders full-bleed gradient (not background, embedded in card)
- [ ] Gradient rotations vary per card (hash shortname → 1 of 4 preset angles)
  - Example rotations in editor.js: 128deg, 138deg, etc.
  - Spot-check: no two urgent cards have identical rotation
- [ ] Gradient colors: pink (#ff1055) → orange (#ff5c2e) → yellow (#ffb03d)
- [ ] Text on urgent card: white (adjusted contrast)
- [ ] Shadow beneath urgent card: colored (`rgba(255,16,85,.15)` or `.18`)

## Active card accent edge

- [ ] Grow any card (surface, columns, list mode)
- [ ] Bottom edge: 2px gradient line
- [ ] Gradient: 90deg `#ff1055` → `#E5F20D` (pink → lime-yellow)
- [ ] Gradient inside 6px radius (no overspill; uses `overflow: hidden`)

## Grow/shrink timing & feel

- [ ] Grow (`⏎`): 240ms, `cubic-bezier(0.16, 1, 0.3, 1)` (ease-out snap)
- [ ] Shrink (`esc` or `⌘⏎`): 240ms same curve
- [ ] No flicker, smooth reflow of neighbors
- [ ] Hover effects (shadow deepening, no scale, no translateY > 1px): feel light & restrained

## Feed integration

- [ ] Every keyboard mutation (move focus, grow, zone moves, title edit) shows `›_` row in feed
- [ ] Feed rows show instruction status: `working`, `needs_confirmation` (for drops), `attention` (on error), `done`
- [ ] Click a feed row for detail panel (shows frontmatter, timing, log)

## Appearance & tokens

### Type sizes (spot-check from board sheet v4)

- [ ] Hero title (urgent/important): EB Garamond 30/1.14, weight 640
- [ ] Post title: EB Garamond 21/1.22, weight 600
- [ ] Note title: EB Garamond 16.5/1.3, weight 520
- [ ] Body (description): Lato 13.5/1.62, weight 400
- [ ] Meta (machine voice): Menlo 10/1.5, weight 400
- [ ] Activity (aside): Lora italic 15/1.5, weight 450

### Color tokens

- [ ] Paper background: `#faf9f7` (off-white)
- [ ] Card container: `#ffffff` (pure white)
- [ ] Text primary: `#1c1c18` (near-black)
- [ ] Text secondary: `#52524c` (medium gray)
- [ ] Meta text: `#8a8a82` (light gray)
- [ ] Faintest meta: `#c8c8c2` (pale gray)
- [ ] Accent (all uses): `#ff1055` (hot pink)

### Containment & shadows

- [ ] Note (flat): no border, no shadow, hover only background tone shift
- [ ] Post (floating): 1px border (`rgba(15,15,12,.055)`), shadow `0 1px 2px rgba(15,15,12,.04), 0 6px 20px rgba(15,15,12,.05)`
- [ ] Urgent/important: borderless, colored shadow (`rgba(255,16,85,.15/.18)`)
- [ ] Radius everywhere: 6px (subtle, never round)
- [ ] Hairlines (`#e8e8e4`) only inside open card sections

## Offline & network

- [ ] After disabling network again, restart app (`npm run dev`)
- [ ] Board loads with no spinner or errors
- [ ] All fonts render crisp (no fallback to system serif)
- [ ] DevTools Network tab: zero external requests logged

## Code quality

- [ ] `npm run typecheck` — zero TypeScript errors
- [ ] `npx eslint .` — zero lint issues
- [ ] `npx vitest run` — all tests pass (116 tests)
- [ ] Accent audit: `grep -n "ff1055\|--accent" surfaces/board/*.css surfaces/board/*.js` — all hits are token defs, focus rings, caret, active-tab underline, edge-grad, editor hover, or column accent dot
- [ ] External URL audit: `grep -rn "https\?://" surfaces/` — zero external URLs (only code comments or localhost)

## Sign-off

- [ ] All items checked
- [ ] No visual regressions vs. sheet v4
- [ ] App ready for production
