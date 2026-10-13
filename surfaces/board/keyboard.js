/**
 * keyboard.js — roving-tabindex focus model + Linear-style keyboard grammar.
 *
 * Public API
 *   initKeyboard({ onOpen, isOpen })
 *     onOpen(card, { editTitle }) — hook for Task 5's grow-in-place editor; no-op until then.
 *     isOpen()                   — predicate; Task 5 passes its own when it registers.
 *   emitInstruction(text, resolved) → fetch promise
 *
 * Focus model
 *   Exactly one [data-card] has tabindex="0" at all times; rest have tabindex="-1".
 *   ↑↓ move within the same visual column (nearest getBoundingClientRect column-x).
 *   ←→ jump to the nearest card in the adjacent column (nearest-x heuristic).
 *   state.focusIdx tracks the focused element's index in els() DOM order.
 *   After every rerender() the caller (board.js) calls restoreFocus() to re-apply
 *   tabindex and optionally re-focus by shortname.
 */

import { state, els, rerender } from './board.js'

// ── Instruction emission ──────────────────────────────────────────────────────

/**
 * POST a pre-resolved instruction through the engine queue.
 * @param {string} text
 * @param {Record<string,string>} resolved
 * @returns {Promise<Response>}
 */
export function emitInstruction(text, resolved) {
  return fetch('/api/instructions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...resolved })
  })
}

// ── Key → action map ──────────────────────────────────────────────────────────

/** @type {Record<string, (c: {shortname:string}) => Promise<Response>>} */
const KEYMAP = {
  a: (c) =>
    emitInstruction(`promote #${c.shortname}`, {
      action: 'update_status',
      card: c.shortname,
      to: 'active'
    }),
  b: (c) =>
    emitInstruction(`backlog #${c.shortname}`, {
      action: 'update_status',
      card: c.shortname,
      to: 'inbox'
    }),
  d: (c) =>
    emitInstruction(`move #${c.shortname} to done`, {
      action: 'update_status',
      card: c.shortname,
      to: 'done'
    }),
  x: (c) => emitInstruction(`delete #${c.shortname}`, { action: 'delete', card: c.shortname })
}

// ── Focus helpers ─────────────────────────────────────────────────────────────

/**
 * Apply roving tabindex: exactly one element gets tabindex="0", rest get "-1".
 */
function applyTabindex() {
  const list = els()
  list.forEach((el, i) => {
    el.tabIndex = i === state.focusIdx ? 0 : -1
  })
}

/**
 * Move DOM focus to the element at state.focusIdx (if it is in the DOM).
 */
function focusAt() {
  const list = els()
  if (!list.length) return
  const idx = Math.min(state.focusIdx, list.length - 1)
  state.focusIdx = idx
  applyTabindex()
  list[idx].focus({ preventScroll: false })
}

/**
 * Re-apply tabindex after a rerender; optionally re-focus if `shouldFocus` is true.
 * Tries to keep focus on the same card by shortname first.
 * @param {string|null} shortname — shortname of the card that was focused before rerender
 * @param {boolean} shouldFocus  — whether to call .focus() (only when keyboard caused the rerender)
 */
export function restoreFocus(shortname, shouldFocus) {
  const list = els()
  if (!list.length) {
    state.focusIdx = 0
    return
  }

  // If we have a shortname, find the element with that data-card attribute
  if (shortname) {
    const idx = Array.from(list).findIndex((el) => el.dataset.card === shortname)
    if (idx !== -1) state.focusIdx = idx
  }

  // Clamp
  state.focusIdx = Math.min(Math.max(0, state.focusIdx), list.length - 1)
  applyTabindex()
  if (shouldFocus) list[state.focusIdx].focus({ preventScroll: false })
}

// ── Column-aware arrow navigation ─────────────────────────────────────────────

/**
 * Partition the els() list into visual columns by their left-edge x coordinate.
 * Two elements are in the same column when their rects' left edges are within 16px.
 * Returns an ordered array of columns; each column is an array of {el, idx, rect}.
 */
function buildColumns() {
  const items = Array.from(els()).map((el, idx) => ({ el, idx, rect: el.getBoundingClientRect() }))
  /** @type {Array<Array<{el:Element,idx:number,rect:DOMRect}>>} */
  const cols = []

  for (const item of items) {
    const existing = cols.find((col) => Math.abs(col[0].rect.left - item.rect.left) < 16)
    if (existing) {
      existing.push(item)
    } else {
      cols.push([item])
    }
  }

  // Sort columns left-to-right, items top-to-bottom within each
  cols.sort((a, b) => a[0].rect.left - b[0].rect.left)
  for (const col of cols) col.sort((a, b) => a.rect.top - b.rect.top)
  return cols
}

/**
 * Move focus up/down within the focused element's visual column.
 * @param {'up'|'down'} dir
 */
function moveVertical(dir) {
  const list = els()
  if (!list.length) return
  const current = list[state.focusIdx]
  const cols = buildColumns()
  const myCol = cols.find((col) => col.some((item) => item.el === current))
  if (!myCol) {
    // Fallback: simple prev/next
    state.focusIdx =
      dir === 'up' ? Math.max(0, state.focusIdx - 1) : Math.min(list.length - 1, state.focusIdx + 1)
    focusAt()
    return
  }
  const posInCol = myCol.findIndex((item) => item.el === current)
  const next =
    dir === 'up'
      ? myCol[Math.max(0, posInCol - 1)]
      : myCol[Math.min(myCol.length - 1, posInCol + 1)]
  if (next && next.el !== current) {
    state.focusIdx = next.idx
    focusAt()
  }
}

/**
 * Move focus left/right to the nearest card in the adjacent column by vertical proximity.
 * @param {'left'|'right'} dir
 */
function moveHorizontal(dir) {
  const list = els()
  if (!list.length) return
  const current = list[state.focusIdx]
  const cols = buildColumns()
  const myColIdx = cols.findIndex((col) => col.some((item) => item.el === current))
  if (myColIdx === -1) return
  const targetColIdx = dir === 'left' ? myColIdx - 1 : myColIdx + 1
  if (targetColIdx < 0 || targetColIdx >= cols.length) return
  const targetCol = cols[targetColIdx]
  const myRect = current.getBoundingClientRect()
  const myMid = myRect.top + myRect.height / 2

  // Pick the item in the target column whose vertical midpoint is nearest
  let best = targetCol[0]
  let bestDist = Infinity
  for (const item of targetCol) {
    const mid = item.rect.top + item.rect.height / 2
    const dist = Math.abs(mid - myMid)
    if (dist < bestDist) {
      bestDist = dist
      best = item
    }
  }
  state.focusIdx = best.idx
  focusAt()
}

// ── Shortname lookup ──────────────────────────────────────────────────────────

/**
 * Return the Card object for the currently focused [data-card] element, or null.
 * @returns {{shortname:string}|null}
 */
function focusedCard() {
  const list = els()
  if (!list.length) return null
  const el = list[state.focusIdx]
  if (!el) return null
  const shortname = el.dataset.card
  return state.snapshot.cards.find((c) => c.shortname === shortname) ?? null
}

// ── Guard helpers ─────────────────────────────────────────────────────────────

function isEditingField() {
  const ae = document.activeElement
  if (!ae) return false
  if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT') return true
  if (ae.isContentEditable) return true
  return false
}

// ── Main initialiser ──────────────────────────────────────────────────────────

/**
 * Attach the keyboard handler to the board root once at boot.
 * @param {{ onOpen?: (card:object, opts:{editTitle:boolean}) => void, isOpen?: () => boolean, onCloseEditor?: () => void }} opts
 *   — onCloseEditor: called before a mode switch so the grow-in-place editor closes cleanly.
 */
export function initKeyboard({
  onOpen = () => {},
  isOpen = () => false,
  onCloseEditor = () => {}
} = {}) {
  _onCloseEditor = onCloseEditor
  const root = document.getElementById('surface-root')
  if (!root) return

  root.addEventListener('keydown', (e) => {
    // Field guard — Esc/Tab inside an open editor are handled by Task 5
    if (isEditingField() && e.key !== 'Escape') return
    // Editor guard — when the editor is open only Esc/Tab pass through (Task 5 owns them)
    if (isOpen() && e.key !== 'Escape' && e.key !== 'Tab') return

    switch (e.key) {
      // ── Close the open card from anywhere (in-field Esc is handled + stopped
      //    by the open card's own wiring before it reaches this listener) ──────
      case 'Escape':
        if (isOpen()) _onCloseEditor()
        break

      // ── Arrow navigation ────────────────────────────────────────────────────
      case 'ArrowUp':
        e.preventDefault()
        moveVertical('up')
        break
      case 'ArrowDown':
        e.preventDefault()
        moveVertical('down')
        break
      case 'ArrowLeft':
        e.preventDefault()
        moveHorizontal('left')
        break
      case 'ArrowRight':
        e.preventDefault()
        moveHorizontal('right')
        break

      // ── Open / edit ─────────────────────────────────────────────────────────
      case 'Enter': {
        // Only fire when a card element (not a topbar tab) has focus
        if (!e.target.closest?.('[data-card]')) break
        const card = focusedCard()
        if (!card) break
        onOpen(card, { editTitle: false })
        break
      }
      case 'e': {
        // Only fire when a card element (not a topbar tab) has focus
        if (!e.target.closest?.('[data-card]')) break
        const card = focusedCard()
        if (!card) break
        onOpen(card, { editTitle: true })
        break
      }

      // ── Status moves ────────────────────────────────────────────────────────
      case 'a':
      case 'x': {
        if (isEditingField()) break
        const card = focusedCard()
        if (!card) break
        KEYMAP[e.key](card)
        break
      }
      case 'b':
      case 'd': {
        // Archive is read-only except for `a` (reactivate) and `x` (delete)
        if (isEditingField() || state.mode === 'archive') break
        const card = focusedCard()
        if (!card) break
        KEYMAP[e.key](card)
        break
      }

      // ── Mode switches ────────────────────────────────────────────────────────
      case '1':
        if (isEditingField()) break
        switchMode('surface')
        break
      case '2':
        if (isEditingField()) break
        switchMode('columns')
        break
      case '3':
        if (isEditingField()) break
        switchMode('list')
        break

      // ── Archive (Shift+A) ────────────────────────────────────────────────────
      case 'A': // Shift+A produces 'A'
        if (isEditingField()) break
        switchMode('archive')
        break

      default:
        break
    }
  })

  // Apply initial tabindex on first paint
  applyTabindex()
}

// ── Mode helper ───────────────────────────────────────────────────────────────

/** Injected by initKeyboard; calls editorClose so switchMode can clean up. */
let _onCloseEditor = () => {}

function switchMode(mode) {
  // Close any open editor before switching modes (no save — mode context changes)
  _onCloseEditor()
  state.mode = mode
  localStorage.setItem('td-mode', mode)
  // Preserve focused shortname across the rAF-batched rerender
  const list = els()
  const shortname = list[state.focusIdx]?.dataset?.card ?? null
  rerender()
  requestAnimationFrame(() => restoreFocus(shortname, true))
}
