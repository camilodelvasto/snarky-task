/**
 * editor.js — field wiring for the open card.
 *
 * The open card is RENDERED declaratively by board.js/cards.js from state.open;
 * this module only wires behavior onto that fresh DOM after each render:
 *   paste sanitize, Tab cycle, Esc (blur-first), Cmd/Ctrl+Enter save,
 *   empty-title restore, action clicks (×, promote, done, drop, +n more),
 *   and the typing-guard flush on field blur.
 *
 * It owns NO state and runs NO animations — open/close/promote movement is
 * the generic FLIP pass in board.js reacting to state changes.
 */

import { esc } from './cards.js'
import { renderMarkdown } from './md.js'

/**
 * Wire interactions on a freshly rendered open card.
 * @param {HTMLElement} el — the [data-open-card] element
 * @param {object} card — the card object from the snapshot
 * @param {{ closeOpen: Function, moveCard: Function, flushRender: Function, editTitle?: boolean }} api
 */
export function wireOpenCard(el, card, api) {
  const titleEl = el.querySelector('[data-field="title"]')
  const descEl = el.querySelector('[data-field="description"]')
  let escBlurred = false

  // ── Keys inside the open card ──────────────────────────────────────────────
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault()
      const focused = document.activeElement
      if (focused === titleEl) descEl?.focus()
      else if (focused === descEl) el.querySelector('[data-act]')?.focus()
      else titleEl?.focus()
      return
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      const focused = document.activeElement
      if (!escBlurred && focused && focused !== el && el.contains(focused)) {
        focused.blur()
        escBlurred = true
      } else {
        api.closeOpen()
      }
      return
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      api.closeOpen()
    }
  })

  // ── Paste sanitize + typing-guard flush ────────────────────────────────────
  for (const field of [titleEl, descEl]) {
    if (!field) continue
    field.addEventListener('paste', (e) => {
      e.preventDefault()
      const text = e.clipboardData?.getData('text/plain') ?? ''
      document.execCommand('insertText', false, text)
    })
    // A deferred SSE render flushes the moment typing stops mattering.
    field.addEventListener('blur', () => api.flushRender())
  }

  // Empty title restores the previous value (the door rejects empty anyway)
  titleEl?.addEventListener('blur', () => {
    if (!titleEl.textContent?.trim()) titleEl.textContent = card.title
  })

  // ── Actions (declarative row — handlers just emit state changes) ───────────
  el.addEventListener('click', (e) => {
    // Click the rendered markdown to edit it in place (raw md, saved on blur).
    const mdBody = e.target.closest('.artifact-md')
    if (mdBody && !mdBody.classList.contains('editing')) {
      e.stopPropagation()
      void editArtifact(el, card, mdBody.dataset.file)
      return
    }
    const act = e.target.closest('[data-act]')?.dataset.act
    if (!act) return
    e.stopPropagation()
    if (act === 'close') api.closeOpen()
    else if (act === 'promote') void api.moveCard(card, 'active', `promote #${card.shortname}`)
    else if (act === 'done') {
      api.closeOpen()
      void api.moveCard(card, 'done')
    } else if (act === 'drop') {
      // Destructive: confirmation happens in the feed; the card stays until confirmed.
      api.closeOpen()
      void api.deleteCard(card)
    } else if (act === 'togglelabel') {
      const tag = e.target.closest('[data-tag]')?.dataset.tag
      if (tag) {
        const on = card.labels.includes(tag)
        void api.emit(`${on ? 'untag' : 'tag'} #${card.shortname} #${tag}`, {
          action: on ? 'unlabel' : 'label',
          card: card.shortname,
          tags: [tag]
        })
      }
    } else if (act === 'untag') {
      const tag = e.target.closest('[data-tag]')?.dataset.tag
      if (tag)
        void api.emit(`untag #${card.shortname} #${tag}`, {
          action: 'unlabel',
          card: card.shortname,
          tags: [tag]
        })
    } else if (act === 'addtag') {
      // Swap the button for a small mono input; Enter emits `tag #card #value`
      const btn = e.target.closest('[data-act="addtag"]')
      const input = document.createElement('input')
      input.className = 'lbl-input'
      input.placeholder = '#tag'
      btn.replaceWith(input)
      input.focus()
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation()
        if (ev.key === 'Enter') {
          const v = input.value
            .trim()
            .replace(/^#/, '')
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
          if (v)
            void api.emit(`tag #${card.shortname} #${v}`, {
              action: 'label',
              card: card.shortname,
              tags: [v]
            })
          input.blur()
        }
        if (ev.key === 'Escape') input.blur()
      })
      input.addEventListener('blur', () => api.flushRender())
    } else if (act === 'artifact') {
      const file = e.target.closest('[data-file]')?.dataset.file
      if (file)
        void (async () => {
          await toggleArtifact(el, card, file)
          // An empty output has no text to click — open it and drop into editing.
          const body = el.querySelector(`[data-artifact-body="${CSS.escape(file)}"]`)
          if (body && !body.hidden && !(body.dataset.raw ?? '').trim())
            void editArtifact(el, card, file)
        })()
    } else if (act === 'addartifact') {
      void addArtifact(card)
    } else if (act === 'more') {
      const activity = el.querySelector('.editor-activity')
      if (activity)
        activity.innerHTML = (card.log ?? [])
          .map((line) => `<div class="t-aside editor-log-line">${esc(line)}</div>`)
          .join('')
    }
  })

  // ── Latest artifact auto-loads — the delegation output IS the point ────────
  const latest = card.artifacts?.[card.artifacts.length - 1]
  if (latest) void toggleArtifact(el, card, latest, { forceOpen: true })

  // A hand-authored output just landed on this card — drop straight into editing
  // it (the create POST seeds the cache empty, so this opens a blank editor).
  if (
    pendingEditFile &&
    pendingEditFile.card === card.shortname &&
    card.artifacts?.includes(pendingEditFile.file)
  ) {
    const f = pendingEditFile.file
    pendingEditFile = null
    void editArtifact(el, card, f)
  }

  // ── Initial focus ──────────────────────────────────────────────────────────
  if (api.editTitle && titleEl) {
    requestAnimationFrame(() => {
      titleEl.focus()
      const range = document.createRange()
      range.selectNodeContents(titleEl)
      range.collapse(false)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    })
  }
}

/** Toggle (and lazily fetch) an artifact's content below its row — rendered
 *  as markdown; the raw source is cached on the element for editing. */
// Artifact content cache, keyed "shortname/file". Decouples display from the
// server round-trip: a board re-render rebuilds the card from scratch, and the
// fresh (empty) body auto-loads from here instead of re-fetching — so an edit
// in flight is never clobbered and content never flashes empty.
const artifactCache = new Map()
const artKey = (card, file) => `${card.shortname}/${file}`

// Set when a hand-authored output is created; the next render of that card drops
// into editing it. Cleared once consumed so it fires exactly once.
let pendingEditFile = null

/** Author a new blank output through the engine door, then edit it on arrival.
 *  The engine logs the creation → the board re-renders with the new row → the
 *  wire pass below sees pendingEditFile and opens it for editing. */
async function addArtifact(card) {
  let res
  try {
    res = await fetch(`/api/artifacts/${encodeURIComponent(card.shortname)}`, { method: 'POST' })
  } catch (err) {
    console.error('[board] add output failed:', err)
    return
  }
  if (!res.ok) {
    console.error(`[board] add output failed: HTTP ${res.status}`)
    return
  }
  const { file } = await res.json()
  artifactCache.set(artKey(card, file), '') // seed empty so the editor opens blank
  pendingEditFile = { card: card.shortname, file }
}

function saveArtifact(card, file, raw) {
  fetch(`/api/artifacts/${encodeURIComponent(card.shortname)}/${encodeURIComponent(file)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: raw })
  }).then(
    (res) => {
      if (!res.ok) console.error(`[board] artifact save failed: HTTP ${res.status}`)
    },
    (err) => console.error('[board] artifact save failed:', err)
  )
}

async function toggleArtifact(el, card, file, { forceOpen = false } = {}) {
  const body = el.querySelector(`[data-artifact-body="${CSS.escape(file)}"]`)
  if (!body) return
  if (!body.hidden && !forceOpen) {
    body.hidden = true
    return
  }
  if (body.dataset.raw === undefined) {
    const key = artKey(card, file)
    if (artifactCache.has(key)) {
      body.dataset.raw = artifactCache.get(key)
    } else {
      try {
        const res = await fetch(
          `/api/artifacts/${encodeURIComponent(card.shortname)}/${encodeURIComponent(file)}`
        )
        body.dataset.raw = res.ok
          ? await res.text()
          : `could not load artifact (HTTP ${res.status})`
      } catch (err) {
        body.dataset.raw = `could not load artifact: ${err}`
      }
      artifactCache.set(key, body.dataset.raw)
    }
    body.innerHTML = renderMarkdown(body.dataset.raw)
  }
  body.hidden = false
}

/** Edit an artifact in place: raw markdown, plaintext-editable, with an explicit
 *  Save/Cancel bar. Save (or clicking truly outside) commits + re-renders pretty;
 *  Cancel discards. All display/cache work is synchronous so it survives any
 *  board re-render the exit may trigger; the save POSTs in the background. */
async function editArtifact(el, card, file) {
  const body = el.querySelector(`[data-artifact-body="${CSS.escape(file)}"]`)
  if (!body) return
  if (body.hidden || body.dataset.raw === undefined)
    await toggleArtifact(el, card, file, { forceOpen: true })
  if (body.classList.contains('editing')) return

  body.classList.add('editing')
  body.textContent = body.dataset.raw ?? ''
  body.contentEditable = 'plaintext-only'
  body.focus()

  const bar = document.createElement('div')
  bar.className = 'artifact-edit-bar'
  bar.innerHTML =
    '<button class="artifact-save" type="button">Save</button>' +
    '<button class="artifact-cancel" type="button">Cancel</button>'
  body.after(bar)

  let done = false
  const finish = (save) => {
    if (done) return
    done = true
    const raw = body.textContent ?? ''
    const changed = save && raw !== body.dataset.raw
    body.contentEditable = 'false'
    body.classList.remove('editing')
    bar.remove()
    if (save) {
      body.dataset.raw = raw
      artifactCache.set(artKey(card, file), raw)
    }
    body.innerHTML = renderMarkdown(body.dataset.raw ?? '')
    if (changed) saveArtifact(card, file, raw)
  }

  // mousedown + preventDefault keeps focus on the field (no premature blur-save)
  bar.querySelector('.artifact-save').addEventListener('mousedown', (e) => {
    e.preventDefault()
    finish(true)
  })
  bar.querySelector('.artifact-cancel').addEventListener('mousedown', (e) => {
    e.preventDefault()
    finish(false)
  })
  // Clicking truly outside the card (or closing it) blurs the field → save,
  // so edits are preserved rather than lost.
  body.addEventListener('blur', () => finish(true), { once: true })
}
