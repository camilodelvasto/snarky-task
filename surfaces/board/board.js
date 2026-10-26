/**
 * board.js — declarative entry point for the snarky-task board surface.
 *
 * One store, one render. EVERYTHING the user sees derives from `state`,
 * including the opened card: `state.open` is a shortname or null, and the
 * expanded card renders in-flow inside .surface-main — no clones, no slots,
 * no bespoke open/close animations. A single generic FLIP pass animates
 * whatever moved between two renders (open, close, promote, SSE moves).
 *
 * Render scheduling: patch() → one rAF-batched render(). While a field inside
 * the open card is focused, renders are DEFERRED (never dropped) and flushed
 * on blur/close — every exit path blurs first, so the deferral cannot deadlock.
 */

import { renderCard, renderRailItem, renderOpenCard, esc, accentPalette } from './cards.js'
import { initKeyboard, restoreFocus, emitInstruction } from './keyboard.js'
import { wireOpenCard } from './editor.js'

// ── Store ─────────────────────────────────────────────────────────────────────
export const state = {
  snapshot: { cards: [], instructions: [] },
  mode: localStorage.getItem('td-mode') ?? 'surface',
  focusIdx: 0,
  open: null, // shortname of the expanded card, or null
  editTitle: false,
  openCard: null, // legacy alias kept for keyboard.js reads; mirrors `open`
  projectMenu: false,
  // Per-card section/output collapse, device-local and in-memory: persists across
  // SSE re-renders within a session (keyed `shortname/section` and `shortname/file`).
  collapse: { sections: {}, outputs: {} },
  // The latest recoverable drop, surfaced as an undo line in the card's activity.
  pendingUndo: null // { shortname, label } | null
}

let renderQueued = false
let renderDeferred = false

// Report the board's open card to the engine (device-local, in-memory, never the
// synced workspace) so a card-verb typed with no #ref targets it. One channel for
// open/click/close — all flow through patch(). Posted on load too, so a board that
// reloaded on its own doesn't leave the engine holding a stale open card.
function reportOpen() {
  fetch('/api/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card: state.open })
  }).catch(() => {})
}
reportOpen() // on load: nothing open yet → clears any stale engine state

/** Apply a partial state change and schedule exactly one render. */
export function patch(partial) {
  Object.assign(state, partial)
  state.openCard = state.open
  if ('open' in partial) reportOpen()
  scheduleRender()
}

function scheduleRender() {
  if (renderQueued) return
  renderQueued = true
  requestAnimationFrame(() => {
    renderQueued = false
    render()
  })
}

/** Cheap stable hash (djb2) — a card node's identity for reconciliation. */
function cardHash(str) {
  let h = 5381
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

/** True while the user is typing in an open-card field — renders defer. */
function typingInOpenCard() {
  const ae = document.activeElement
  return !!(
    ae &&
    (ae.isContentEditable || ae.tagName === 'INPUT') &&
    ae.closest('[data-open-card]')
  )
}

/** Flush a deferred render (called on field blur and on every close path). */
export function flushRender() {
  if (renderDeferred) {
    renderDeferred = false
    scheduleRender()
  }
}

// Compatibility export: synchronous render request (keyboard.js calls this).
export function rerender() {
  scheduleRender()
}

// ── Optimistic moves ──────────────────────────────────────────────────────────
const pendingMoves = new Map() // shortname → { to, at }
const PENDING_TTL = 30_000

function displayStatus(c) {
  const p = pendingMoves.get(c.shortname)
  if (!p) return c.status
  if (c.status === p.to || Date.now() - p.at > PENDING_TTL) {
    pendingMoves.delete(c.shortname)
    return c.status
  }
  return p.to
}

function isPending(c) {
  return pendingMoves.has(c.shortname)
}

/** Optimistically move a card and emit the matching pre-resolved instruction. */
export function moveCard(card, to, text) {
  pendingMoves.set(card.shortname, { to, at: Date.now() })
  scheduleRender()
  return emitInstruction(text ?? `move #${card.shortname} to ${to}`, {
    action: 'update_status',
    card: card.shortname,
    to
  })
}

/** Emit a delete (destructive — the engine's confirmation gate applies; no optimism). */
export function deleteCard(card) {
  return emitInstruction(`delete #${card.shortname}`, {
    action: 'delete',
    card: card.shortname
  })
}

// ── Open / close (the only two verbs the editor needs from the store) ─────────
/** Persist the open card's edited title/description through the door, then blur
 *  so the typing guard can't defer the next render. Shared by every exit path
 *  (close to board, or switch straight to another card). */
function persistOpenEdits() {
  if (!state.open) return
  const container = root.querySelector('[data-open-card]')
  const card = state.snapshot.cards.find((c) => c.shortname === state.open)
  if (container && card) {
    const titleEl = container.querySelector('[data-field="title"]')
    const descEl = container.querySelector('[data-field="description"]')
    const newTitle = (titleEl?.textContent ?? card.title).trim()
    const newDesc = descEl?.textContent?.trim() ?? card.description ?? ''
    const changed = {}
    if (newTitle && newTitle !== card.title) changed.title = newTitle
    if (newDesc !== (card.description ?? '')) changed.description = newDesc
    if (Object.keys(changed).length > 0) {
      fetch(`/api/cards/${card.shortname}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changed)
      }).then(
        (res) => {
          if (!res.ok) console.error(`[board] save failed: HTTP ${res.status} #${card.shortname}`)
        },
        (err) => console.error('[board] save failed:', err)
      )
    }
  }
  if (document.activeElement && container?.contains(document.activeElement)) {
    document.activeElement.blur()
  }
}

/** Open a card. This is the ONE route change — `state.open` is the source of
 *  truth, and switching from an already-open card saves its edits first, so a
 *  single declarative patch exits the old card clean and grows the new one. */
let scrollTopOnOpen = false // consumed by render(): smooth-scroll the open card into view

export function openCard(card, { editTitle = false } = {}) {
  if (state.mode === 'archive') return
  if (state.open && state.open !== card.shortname) persistOpenEdits()
  scrollTopOnOpen = true
  patch({ open: card.shortname, editTitle })
}

/** Close the open card back to the board, saving its edits through the door. */
export function closeOpen({ save = true } = {}) {
  if (!state.open) return
  if (save) persistOpenEdits()
  const closedShortname = state.open
  patch({ open: null, editTitle: false })
  flushRender()
  requestAnimationFrame(() => restoreFocus(closedShortname, true))
}

/** Cards with an instruction currently working on them — they shimmer. */
function busySet() {
  return new Set(
    (state.snapshot.instructions ?? [])
      .filter((i) => i.status === 'working' && i.card)
      .map((i) => i.card)
  )
}

/** Labels that earn the gradient edge — declared in config.json ui.highlight_labels. */
function highlightLabels() {
  return state.snapshot.ui?.highlight_labels ?? []
}

/** Label → gradient palette — declared in config.json ui.accent_labels. */
function accentLabels() {
  return state.snapshot.ui?.accent_labels ?? undefined
}

/** The label that keeps a card off external agents — config.json ui.private_label. */
function privateLabel() {
  return state.snapshot.ui?.private_label ?? 'private'
}

// ── Zones ─────────────────────────────────────────────────────────────────────
function zones(cards) {
  return {
    surface: cards.filter((c) => displayStatus(c) === 'active'),
    rail: cards.filter((c) => displayStatus(c) === 'inbox' || displayStatus(c) === 'waiting'),
    archive: cards.filter((c) => displayStatus(c) === 'done' || displayStatus(c) === 'dropped')
  }
}

// ── DOM refs ──────────────────────────────────────────────────────────────────
const root = document.getElementById('surface-root')

// A recoverable drop is a command like any other, so its undo is a notification in
// the card's activity — not a floating toast. We record the pending undo in state and
// auto-open the activity section so the line is visible; renderOpenCard draws
// `↩ <label> dropped · undo`. Cleared on undo (see editor.js), project switch, or a
// timeout. State survives SSE re-renders, so the drop's own broadcast can't wipe it.
function flagUndo(shortname, label) {
  state.pendingUndo = { shortname, label }
  state.collapse.sections[`${shortname}/activity`] = true // show the undo line
  clearTimeout(flagUndo._t)
  flagUndo._t = setTimeout(() => {
    if (state.pendingUndo && state.pendingUndo.shortname === shortname) {
      state.pendingUndo = null
      scheduleRender()
    }
  }, 30000)
  scheduleRender()
}

/** The open card's collapse state, as a stable value for its render sig — only the
 *  entries belonging to this card, so one card's toggles don't rebuild another's. */
function collapseSigFor(name) {
  const mine = (obj) => Object.entries(obj).filter(([k]) => k.startsWith(`${name}/`))
  return [mine(state.collapse.sections), mine(state.collapse.outputs)]
}

/** Clear the pending-undo notification (after an undo lands, or on nav away). */
export function clearUndo() {
  if (!state.pendingUndo) return
  state.pendingUndo = null
  clearTimeout(flagUndo._t)
  scheduleRender()
}

export function els() {
  return root.querySelectorAll('[data-card]')
}

// ── Topbar ────────────────────────────────────────────────────────────────────
const TABS = ['surface', 'columns', 'list', 'archive']

function renderTopbar() {
  const proj = state.snapshot.project
  const chip = proj
    ? `<div class="proj-wrap"><button class="proj-chip" data-proj-toggle>${esc(proj.current)} ▾</button>` +
      (state.projectMenu
        ? `<div class="proj-menu">` +
          proj.list
            .map(
              (n) =>
                `<button class="proj-item${n === proj.current ? ' on' : ''}" data-proj="${esc(n)}">${esc(n)}</button>`
            )
            .join('') +
          `</div>`
        : '') +
      `</div>`
    : ''
  return (
    `<nav class="topbar" aria-label="View modes">` +
    chip +
    TABS.map(
      (t) =>
        `<button class="tab${state.mode === t ? ' active' : ''}" data-mode="${esc(t)}">${esc(t)}</button>`
    ).join('') +
    `</nav>`
  )
}

// ── Surface mode ──────────────────────────────────────────────────────────────
function sortSurface(cards) {
  return [...cards].sort((a, b) => {
    const au = accentPalette(a, accentLabels()) ? 1 : 0
    const bu = accentPalette(b, accentLabels()) ? 1 : 0
    if (au !== bu) return bu - au
    const aTime = a.log.length ? a.log[a.log.length - 1] : a.created
    const bTime = b.log.length ? b.log[b.log.length - 1] : b.created
    return bTime < aTime ? -1 : bTime > aTime ? 1 : 0
  })
}

function renderSurface(z) {
  // The open card (from ANY zone) renders expanded above the masonry, in-flow.
  const openCardObj = state.open
    ? state.snapshot.cards.find((c) => c.shortname === state.open)
    : null
  const openHtml = openCardObj
    ? renderOpenCard(openCardObj, {
        status: displayStatus(openCardObj),
        highlightLabels: highlightLabels(),
        accents: accentLabels(),
        privateLabel: privateLabel(),
        busy: busySet().has(openCardObj.shortname),
        elementTypes: state.snapshot.elementTypes ?? {},
        collapse: state.collapse,
        pendingUndo: state.pendingUndo
      })
    : ''

  const surfaceCards = sortSurface(z.surface).filter((c) => c.shortname !== state.open)
  const surfaceHtml = surfaceCards
    .map((c) =>
      renderCard(c, {
        zone: 'surface',
        status: displayStatus(c),
        highlightLabels: highlightLabels(),
        accents: accentLabels(),
        privateLabel: privateLabel()
      })
    )
    .join('')
  const railHtml = z.rail
    .filter((c) => c.shortname !== state.open)
    .map((c) => renderRailItem(c, { busy: busySet().has(c.shortname) }))
    .join('')

  return (
    `<div class="surface-layout">` +
    `<div class="surface-main">` +
    openHtml +
    `<div class="surface">${surfaceHtml}</div>` +
    `</div>` +
    `<aside class="rail">` +
    `<div class="rail-label t-meta">backlog</div>` +
    railHtml +
    `</aside>` +
    `</div>`
  )
}

// ── Columns mode — kanban order; backlog folds inbox + waiting (zone model) ──
const COLUMNS = [
  { key: 'backlog', statuses: ['inbox', 'waiting'], dropTo: 'inbox' },
  { key: 'active', statuses: ['active'], dropTo: 'active' },
  { key: 'done', statuses: ['done'], dropTo: 'done' },
  { key: 'dropped', statuses: ['dropped'], dropTo: 'dropped' }
]

function renderColumns() {
  const colsHtml = COLUMNS.map((col) => {
    const colCards = state.snapshot.cards.filter((c) => col.statuses.includes(displayStatus(c)))
    return (
      `<section class="col ${esc(col.key)}" data-col="${esc(col.dropTo)}">` +
      `<h2 class="col-header">${esc(col.key)} · ${colCards.length}</h2>` +
      colCards
        .map((c) =>
          renderCard(c, {
            zone: 'columns',
            status: displayStatus(c),
            draggable: true,
            pending: isPending(c),
            highlightLabels: highlightLabels(),
            accents: accentLabels(),
            privateLabel: privateLabel(),
            busy: busySet().has(c.shortname)
          })
        )
        .join('') +
      `</section>`
    )
  }).join('')
  return `<div id="board" class="board-columns">${colsHtml}</div>`
}

// ── List mode ─────────────────────────────────────────────────────────────────
const STATUS_COLORS = {
  inbox: '#3f74c9',
  active: '#7c5cbf',
  waiting: '#a3700c',
  done: '#1e9e63',
  dropped: 'var(--ink-4)'
}

function renderListRow(c) {
  const ds = displayStatus(c)
  const color = STATUS_COLORS[ds] ?? 'var(--ink-4)'
  const pendingClass = isPending(c) ? ' pending' : ''
  const metaParts = []
  if (c.due) metaParts.push(esc(c.due.slice(0, 10)))
  if (c.artifacts && c.artifacts.length)
    metaParts.push(`${c.artifacts.length} artifact${c.artifacts.length !== 1 ? 's' : ''}`)
  const time =
    c.log && c.log.length ? (String(c.log[c.log.length - 1]).match(/\d{2}:\d{2}/) ?? [''])[0] : ''
  if (time) metaParts.push(esc(time))

  return (
    `<div class="list-row${pendingClass}${busySet().has(c.shortname) ? ' busy' : ''}" data-card="${esc(c.shortname)}" tabindex="-1">` +
    `<span class="list-dot" style="background:${color}"></span>` +
    `<span class="t-note list-title">${esc(c.title)}</span>` +
    (metaParts.length ? `<span class="t-meta list-meta">${metaParts.join(' · ')}</span>` : '') +
    `</div>`
  )
}

function renderList() {
  const openCardObj = state.open
    ? state.snapshot.cards.find((c) => c.shortname === state.open)
    : null
  const openHtml = openCardObj
    ? renderOpenCard(openCardObj, {
        status: displayStatus(openCardObj),
        highlightLabels: highlightLabels(),
        accents: accentLabels(),
        privateLabel: privateLabel(),
        busy: busySet().has(openCardObj.shortname),
        elementTypes: state.snapshot.elementTypes ?? {},
        collapse: state.collapse,
        pendingUndo: state.pendingUndo
      })
    : ''
  const cards = state.snapshot.cards.filter(
    (c) => c.status !== 'done' && c.status !== 'dropped' && c.shortname !== state.open
  )
  if (!cards.length && !openHtml) return `<div class="mode-placeholder t-meta">no cards yet</div>`
  return `<div class="list-view">${openHtml}${cards.map(renderListRow).join('')}</div>`
}

// ── Archive mode ──────────────────────────────────────────────────────────────
function archiveDate(c) {
  const src = c.log && c.log.length ? String(c.log[c.log.length - 1]) : String(c.created ?? '')
  const m = src.match(/\d{4}-\d{2}-\d{2}/)
  return m ? m[0] : '2000-01-01'
}

function renderArchiveRow(c) {
  const stamp = c.status === 'done' ? 'done' : 'dropped'
  return (
    `<div class="list-row archive-row" data-card="${esc(c.shortname)}" data-archive-status="${esc(c.status)}" tabindex="-1">` +
    `<span class="t-meta archive-stamp">${stamp}</span>` +
    `<span class="t-note list-title">${esc(c.title)}</span>` +
    `</div>`
  )
}

function renderArchive() {
  const archived = state.snapshot.cards.filter((c) => c.status === 'done' || c.status === 'dropped')
  if (!archived.length) return `<div class="mode-placeholder t-meta">archive is empty</div>`
  const byDate = new Map()
  for (const c of archived) {
    const d = archiveDate(c)
    if (!byDate.has(d)) byDate.set(d, [])
    byDate.get(d).push(c)
  }
  const dates = [...byDate.keys()].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0))
  const html = dates
    .map(
      (d) =>
        `<div class="archive-group">` +
        `<div class="t-meta archive-group-header">${esc(d)}</div>` +
        byDate.get(d).map(renderArchiveRow).join('') +
        `</div>`
    )
    .join('')
  return `<div class="list-view archive-view">${html}</div>`
}

// ── Generic FLIP: animate whatever moved between two renders ──────────────────
function capturePositions() {
  const map = new Map()
  for (const el of root.querySelectorAll('[data-card]'))
    map.set(el.dataset.card, el.getBoundingClientRect())
  return map
}

function flip(before) {
  const styles = getComputedStyle(document.documentElement)
  const dur = parseInt(styles.getPropertyValue('--dur'), 10) || 180
  const ease = styles.getPropertyValue('--ease').trim() || 'cubic-bezier(0.16,1,0.3,1)'
  // Moves get their own pace: a reorder hop crosses most of the board, and at
  // --dur with the expo-out curve the travel is over in ~30ms — a teleport.
  const durMove = parseInt(styles.getPropertyValue('--dur-move'), 10) || 380
  const easeMove = styles.getPropertyValue('--ease-move').trim() || 'cubic-bezier(0.3,0.7,0.25,1)'
  for (const el of root.querySelectorAll('[data-card]')) {
    const prev = before.get(el.dataset.card)
    const now = el.getBoundingClientRect()
    if (!prev) {
      // Newly appeared (e.g. the open card) — gentle fade/slide in
      el.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1 }], {
        duration: dur,
        easing: ease
      })
      continue
    }
    const dx = prev.left - now.left
    const dy = prev.top - now.top
    const sx = now.width > 0 ? prev.width / now.width : 1
    if (dx || dy || Math.abs(sx - 1) > 0.01) {
      el.style.transformOrigin = 'top left'
      el.animate(
        [{ transform: `translate(${dx}px,${dy}px) scale(${sx},1)` }, { transform: 'none' }],
        { duration: durMove, easing: easeMove }
      )
    }
  }
}

// ── The one render ────────────────────────────────────────────────────────────
function render() {
  if (typingInOpenCard()) {
    renderDeferred = true
    return
  }

  // Refute optimistic placements for attention-parked instructions
  for (const s of [...pendingMoves.keys()]) {
    if ((state.snapshot.instructions ?? []).some((i) => i.status === 'attention' && i.card === s))
      pendingMoves.delete(s)
  }
  // Close the open card if it vanished from the snapshot (deleted elsewhere)
  if (state.open && !state.snapshot.cards.some((c) => c.shortname === state.open)) {
    state.open = null
    state.openCard = null
    reportOpen()
  }

  const before = capturePositions()
  // Carry container scroll: the scroll boxes themselves (.surface-main/.rail/.col/
  // .list-view) are rebuilt fresh each render, so their scrollTop resets — restore
  // it after the swap. (Card nodes that get adopted keep their own scroll inherently.)
  const scrolled = Array.from(root.querySelectorAll('.surface-main, .rail, .col, .list-view'))
    .filter((el) => el.scrollTop > 0)
    .map((el) => ({ cls: el.className, top: el.scrollTop }))
  // A rebuilt open card loses its artifact body scroll (repopulated by wireOpenCard)
  // — carry each by file. No-op when the open card is adopted (same node, scroll kept).
  const artifactScrolls = Array.from(root.querySelectorAll('.editor-out-body[data-out-body]'))
    .filter((el) => el.scrollTop > 0)
    .map((el) => ({ file: el.dataset.file, top: el.scrollTop }))
  const z = zones(state.snapshot.cards)

  let inner
  switch (state.mode) {
    case 'columns':
      inner = renderColumns()
      break
    case 'list':
      inner = renderList()
      break
    case 'archive':
      inner = renderArchive()
      break
    default:
      inner = renderSurface(z)
  }

  // ── Declarative reconcile ───────────────────────────────────────────────────
  // Build the next tree detached, then ADOPT the existing DOM node for every card
  // whose rendered inputs are unchanged (keyed by shortname, matched by a data-sig
  // of its source data). Only genuinely-changed cards get a fresh node — so
  // creating or promoting a card touches that card alone, and every other node
  // (above all the open card you're working in) keeps its DOM, scroll, focus and
  // unsaved edits. No whole-panel teardown.
  const next = document.createElement('div')
  next.innerHTML = renderTopbar() + inner
  const uiToken = JSON.stringify(state.snapshot.ui ?? {})
  const busy = busySet()
  const cardByName = new Map(state.snapshot.cards.map((c) => [c.shortname, c]))
  for (const node of next.querySelectorAll('[data-card]')) {
    const name = node.dataset.card
    const c = cardByName.get(name)
    const isOpen = node.hasAttribute('data-open-card')
    node.dataset.sig = cardHash(
      JSON.stringify([
        c ?? name,
        displayStatus(c ?? { shortname: name, status: '' }),
        busy.has(name),
        isOpen,
        state.mode,
        uiToken,
        // The open card's collapse + undo are VIEW state, not in `c`. Without them
        // in the sig, a toggle leaves the hash unchanged → the node is adopted and
        // the freshly-rendered (expanded/collapsed) HTML is discarded. Fold them in
        // so a toggle rebuilds the open card; unrelated renders still adopt it.
        isOpen ? collapseSigFor(name) : 0,
        isOpen ? state.pendingUndo : 0
      ])
    )
  }
  const live = new Map()
  for (const el of root.querySelectorAll('[data-card]')) live.set(el.dataset.card, el)
  let adoptedOpen = false
  for (const fresh of next.querySelectorAll('[data-card]')) {
    const old = live.get(fresh.dataset.card)
    if (old && old.dataset.sig === fresh.dataset.sig) {
      if (fresh.hasAttribute('data-open-card')) adoptedOpen = true
      fresh.replaceWith(old) // move the live node into the next tree, state intact
    }
  }
  root.replaceChildren(...Array.from(next.childNodes))

  // Restore container scroll BEFORE flip measures the new rects.
  if (scrolled.length) {
    const fresh = Array.from(root.querySelectorAll('.surface-main, .rail, .col, .list-view'))
    for (const s of scrolled) {
      const el = fresh.find((f) => f.className === s.cls && f.scrollTop !== s.top)
      if (el) el.scrollTop = s.top
    }
  }
  flip(before)

  // A freshly opened card renders at the top of its scroll box — glide there.
  if (scrollTopOnOpen) {
    scrollTopOnOpen = false
    root
      .querySelector('[data-open-card]')
      ?.closest('.surface-main, .list-view')
      ?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  // Wire the open card ONLY when it was freshly built — an adopted node keeps the
  // listeners (and loaded artifact / in-progress edit) from its previous life.
  if (!adoptedOpen) {
    const openEl = root.querySelector('[data-open-card]')
    if (openEl) {
      const card = state.snapshot.cards.find((c) => c.shortname === state.open)
      if (card)
        wireOpenCard(openEl, card, {
          closeOpen,
          moveCard,
          deleteCard,
          emit: emitInstruction,
          flushRender,
          flagUndo,
          clearUndo,
          // Flip a section's / output's collapse state and persist it (so a later
          // render restores it via the sig). Returns the new open? — the editor
          // toggles the DOM directly, avoiding a full rebuild + FLIP (which jumped).
          toggleSection: (sec) => {
            const k = `${card.shortname}/${sec}`
            const def = sec === 'activity' ? false : true
            const open = !(state.collapse.sections[k] ?? def)
            state.collapse.sections[k] = open
            return open
          },
          toggleOutput: (file) => {
            const k = `${card.shortname}/${file}`
            const open = !(state.collapse.outputs[k] ?? false)
            state.collapse.outputs[k] = open
            return open
          },
          editTitle: state.editTitle
        })
      state.editTitle = false // focus intent consumed by the first wire
    }
  }

  // Reapply the open artifact's scroll ALWAYS — reattaching nodes into root (even
  // an adopted open card) can reset its overflow children's scrollTop, so restore
  // it explicitly rather than trusting the move to carry it.
  for (const a of artifactScrolls) {
    const fresh = root.querySelector(`.editor-out-body[data-file="${CSS.escape(a.file)}"]`)
    if (fresh) fresh.scrollTop = a.top
  }
}

// ── Delegated clicks (declarative handlers — one listener, state decides) ─────
root.addEventListener('click', (e) => {
  // Project chip toggle — opens/closes the project dropdown
  if (e.target.closest('[data-proj-toggle]')) {
    patch({ projectMenu: !state.projectMenu })
    return
  }

  // Project item — emit bare text instruction (CLI-parsed); close menu
  const projItem = e.target.closest('[data-proj]')
  if (projItem) {
    const name = projItem.dataset.proj
    void emitInstruction(`project ${name}`)
    patch({ projectMenu: false })
    return
  }

  // Any other click closes the project menu (avoid wasted renders when already closed)
  if (state.projectMenu) {
    patch({ projectMenu: false })
  }

  const tab = e.target.closest('.tab')
  if (tab) {
    closeOpen()
    patch({ mode: tab.dataset.mode })
    localStorage.setItem('td-mode', tab.dataset.mode)
    return
  }

  // Delete icon on a closed card — same door as the keyboard's `x`
  const del = e.target.closest('[data-act="carddel"]')
  if (del) {
    const shortname = del.closest('[data-card]')?.dataset.card
    const card = state.snapshot.cards.find((c) => c.shortname === shortname)
    if (card) void deleteCard(card)
    return
  }

  // Clicks inside the open card are handled by its own wiring
  if (e.target.closest('[data-open-card]')) return

  const cardEl = e.target.closest('[data-card]')
  const clicked = cardEl?.dataset.card ?? null

  // A card click is a route change: open that card. openCard() saves and exits
  // any already-open card first, so clicking straight from one card to another
  // transitions cleanly in a single declarative patch — no close-then-reclick.
  if (clicked) {
    const card = state.snapshot.cards.find((c) => c.shortname === clicked)
    if (!card) return
    const idx = Array.from(els()).indexOf(cardEl)
    if (idx !== -1) state.focusIdx = idx
    openCard(card)
    return
  }

  // Clicked empty space with a card open → close back to the board.
  if (state.open) closeOpen()
})

// ── Drag-drop (columns mode) ──────────────────────────────────────────────────
let dragged = null

root.addEventListener('dragstart', (e) => {
  const el = e.target.closest('[data-s]')
  if (!el) return
  dragged = el.dataset.s
  el.classList.add('dragging')
  e.dataTransfer.effectAllowed = 'move'
  e.dataTransfer.setData('text/plain', dragged)
})

root.addEventListener('dragend', () => {
  dragged = null
  for (const el of root.querySelectorAll('.dragging')) el.classList.remove('dragging')
  for (const el of root.querySelectorAll('.drop-target')) el.classList.remove('drop-target')
})

root.addEventListener('dragover', (e) => {
  if (!dragged) return
  // Drop zones: kanban columns, and the surface masonry (rail → active)
  const zone = e.target.closest('.col') ?? e.target.closest('.surface-main')
  if (!zone) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  for (const el of root.querySelectorAll('.drop-target')) el.classList.remove('drop-target')
  zone.classList.add('drop-target')
})

root.addEventListener('drop', (e) => {
  if (!dragged) return
  const zone = e.target.closest('.col') ?? e.target.closest('.surface-main')
  if (!zone) return
  e.preventDefault()
  const target = zone.dataset.col ?? 'active' // masonry drop activates
  const card = state.snapshot.cards.find((x) => x.shortname === dragged)
  if (card && card.status !== target) void moveCard(card, target)
})

// ── SSE + bootstrap ───────────────────────────────────────────────────────────
// Transient `open #card` nav from the feed: act once per new seq. The FIRST
// snapshot sets the baseline (seq present at load, or 0) so a reload never
// re-opens a stale request — but a nav that ARRIVES after load always acts,
// even if it's the first one ever (baseline would otherwise swallow it).
let navReady = false
let lastNavSeq = 0
function applyNav(snap) {
  if (!navReady) {
    navReady = true
    lastNavSeq = snap.nav?.seq ?? 0
    return
  }
  const nav = snap.nav
  if (nav && nav.seq > lastNavSeq) {
    lastNavSeq = nav.seq
    const card = snap.cards.find((c) => c.shortname === nav.card)
    if (card) openCard(card)
  }
}

// The board renders ONLY what the board shows: the cards, the ui config, the
// active project, and the two instruction-derived bits it reflects (which cards
// are working → shimmer, which are attention-parked → refute optimistic moves).
// Everything else in a snapshot — the whole feed log, done-row TTL sweeps, every
// other instruction state change — is the LEFT panel's business. Signing that
// projection lets the board sit still through all of it: the two surfaces share
// one event stream but are independent in what they react to.
function boardSignature(snap) {
  const withCard = (status) =>
    (snap.instructions ?? [])
      .filter((i) => i.status === status && i.card)
      .map((i) => i.card)
      .sort()
  return JSON.stringify({
    cards: snap.cards,
    ui: snap.ui,
    project: snap.project,
    working: withCard('working'),
    attention: withCard('attention')
  })
}
let lastBoardSig = null

const events = new EventSource('/api/events')
events.onmessage = (e) => {
  const snap = JSON.parse(e.data)
  state.snapshot = snap
  applyNav(snap) // `open #card` nav is a real intent — handled regardless of the signature
  const sig = boardSignature(snap)
  if (sig === lastBoardSig) return // nothing the board draws changed — stay put
  lastBoardSig = sig
  const focused = els()[state.focusIdx]
  const focusedShortname = focused?.dataset?.card ?? null
  scheduleRender()
  requestAnimationFrame(() => {
    if (typingInOpenCard()) return // never steal focus (and the edit) from an active field
    const activeOnBoard = document.activeElement?.closest('[data-card]') != null
    restoreFocus(focusedShortname, activeOnBoard)
  })
}

fetch('/api/state')
  .then((r) => r.json())
  .then((s) => {
    state.snapshot = s
    applyNav(s)
    lastBoardSig = boardSignature(s)
    scheduleRender()
  })

// ── Keyboard ──────────────────────────────────────────────────────────────────
initKeyboard({
  onOpen: (card, opts) => openCard(card, opts),
  isOpen: () => state.open !== null,
  onCloseEditor: () => closeOpen()
})
