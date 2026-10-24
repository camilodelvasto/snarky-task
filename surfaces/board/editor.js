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
    // A single click on rendered output is for reading/selecting; editing is the
    // `edit` action or a double-click (see the dblclick handler below).
    const act = e.target.closest('[data-act]')?.dataset.act
    if (!act) return
    e.stopPropagation()
    // Element actions inside a note/date/person row → the declarative op endpoint.
    // (Must precede the card-level `drop` below, which deletes the whole card.)
    const elRow = e.target.closest('[data-el-id]')
    if (elRow && (act === 'scratch' || act === 'restore' || act === 'drop')) {
      const type = elRow.dataset.elType
      const p = elementOp(card.shortname, type, act === 'restore' ? 'scratch' : act, {
        id: elRow.dataset.elId
      })
      // A drop is destructive-but-recoverable: the undo shows up in activity.
      if (act === 'drop') void p.then((ok) => ok && api.flagUndo?.(card.shortname, type))
      else void p
      return
    }
    // Collapse a whole section — the entire header row is the target (the `write`
    // button carves itself out by matching its own data-act first). Toggle the DOM
    // in place (no rebuild/FLIP); api persists the state for the next real render.
    if (act === 'toggle-sec') {
      const sec = e.target.closest('[data-sec]')?.dataset.sec
      const secEl = e.target.closest('.editor-sec')
      if (sec && secEl) {
        const open = api.toggleSection?.(sec)
        secEl.dataset.collapsed = open ? 'false' : 'true'
        const arrow = secEl.querySelector('.editor-sec-arrow')
        if (arrow) arrow.textContent = open ? '▾' : '▸'
      }
      return
    }
    // Open/close one output's full body — in place, lazy-loading on first open.
    if (act === 'toggle-out') {
      const file = e.target.closest('[data-file]')?.dataset.file
      const out = e.target.closest('.editor-out')
      if (!file || !out) return
      const open = api.toggleOutput?.(file)
      const body = out.querySelector('.editor-out-body')
      if (!open) {
        out.dataset.collapsed = 'true'
        if (body) body.hidden = true
      } else {
        // Fill the body while it's still hidden, THEN reveal — a first open never
        // flashes an empty box that grows when the fetch lands (no jump).
        void loadOutputBody(el, card, file).then(() => {
          out.dataset.collapsed = 'false'
          if (body) body.hidden = false
        })
      }
      return
    }
    // Undo the latest recoverable drop (the activity notification).
    if (act === 'undo') {
      void fetch(`/api/cards/${encodeURIComponent(card.shortname)}/restore`, { method: 'POST' })
      api.clearUndo?.()
      return
    }
    if (act === 'write-note') {
      startNoteInput(el, card, api)
      return
    }
    if (act === 'write-output') {
      void addArtifact(card).then((file) => {
        if (file) {
          pendingEditFile = { card: card.shortname, file }
          api.toggleOutput?.(file) // open the new row → the wire pass drops into editing
        }
      })
      return
    }
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
    } else if (act === 'output-edit') {
      const file = e.target.closest('[data-file]')?.dataset.file
      if (!file) return
      const out = e.target.closest('.editor-out')
      if (out?.dataset.collapsed === 'true') {
        // Expand first; the wire pass opens the editor once the body is visible.
        pendingEditFile = { card: card.shortname, file }
        api.toggleOutput?.(file)
      } else {
        void editOutput(el, card, file)
      }
    } else if (act === 'output-drop') {
      const file = e.target.closest('[data-file]')?.dataset.file
      if (file) void dropArtifact(card, file).then((ok) => ok && api.flagUndo?.(card.shortname, 'output'))
    }
  })

  // Double-click a note → edit the text in place with a save · cancel row.
  // Mirrors the artifact editor: mousedown+preventDefault keeps focus so a blur
  // doesn't race the save; the contenteditable field sits inside [data-open-card]
  // so SSE re-renders defer while editing.
  el.addEventListener('dblclick', (e) => {
    // Double-click an output (row or body) → edit its full text, expanding first.
    const outEl = e.target.closest('.editor-out')
    if (outEl) {
      e.stopPropagation()
      const file = outEl.dataset.file
      if (outEl.dataset.collapsed === 'true') api.toggleOutput?.(file) // persist open
      void editOutput(el, card, file)
      return
    }
    const noteEl = e.target.closest('.editor-note[data-el-id]')
    if (!noteEl || noteEl.classList.contains('editing')) return
    const textEl = noteEl.querySelector('.editor-note-text')
    const acts = noteEl.querySelector('.editor-note-acts')
    if (!textEl || !acts) return
    e.stopPropagation()
    const original = textEl.textContent
    const prevActs = acts.innerHTML
    noteEl.classList.add('editing')
    textEl.setAttribute('contenteditable', 'plaintext-only')
    textEl.focus()
    acts.innerHTML =
      `<a class="editor-note-act save" data-noteact="save">save</a>` +
      `<span class="editor-note-sep"> · </span>` +
      `<a class="editor-note-act" data-noteact="cancel">cancel</a>`
    let finished = false
    const finish = (save) => {
      if (finished) return
      finished = true
      const text = textEl.textContent
      noteEl.classList.remove('editing')
      textEl.removeAttribute('contenteditable')
      acts.innerHTML = prevActs
      if (save && text !== original)
        void elementOp(card.shortname, 'note', 'edit', { id: noteEl.dataset.elId, text })
      else if (!save) textEl.textContent = original
      api.flushRender()
    }
    acts.querySelector('[data-noteact="save"]').addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      finish(true)
    })
    acts.querySelector('[data-noteact="cancel"]').addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      finish(false)
    })
    textEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault()
        finish(true)
      } else if (ev.key === 'Escape') {
        ev.preventDefault()
        ev.stopPropagation()
        finish(false)
      }
    })
    textEl.addEventListener('blur', () => finish(true))
  })

  // ── Expanded outputs load their body (content is lazy; visibility is state) ──
  el.querySelectorAll('.editor-out[data-collapsed="false"]').forEach((out) => {
    void loadOutputBody(el, card, out.dataset.file)
  })

  // A just-created or edit-requested output drops into editing once it's visible.
  // (write-output seeds the cache empty, so this opens a blank editor.)
  if (
    pendingEditFile &&
    pendingEditFile.card === card.shortname &&
    card.artifacts?.includes(pendingEditFile.file)
  ) {
    const f = pendingEditFile.file
    pendingEditFile = null
    void editOutput(el, card, f)
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
  return file
}

/** Insert an inline note field at the end of the notes section — same left bar +
 *  garamond as a real note, so the caret sits where the text will. Enter or
 *  Cmd/Ctrl+Enter saves, Shift+Enter is a newline, Esc cancels. The `finished`
 *  guard is load-bearing: Enter fires `done` AND the subsequent blur fires it too,
 *  so without the guard a single note was added twice. */
function startNoteInput(el, card, api) {
  const items = el.querySelector('.editor-sec[data-sec="notes"] .editor-sec-items')
  if (!items || items.querySelector('.editor-note.writing')) return
  const wrap = document.createElement('div')
  wrap.className = 'editor-note writing'
  const input = document.createElement('div')
  input.className = 'editor-note-text'
  input.setAttribute('contenteditable', 'plaintext-only')
  input.setAttribute('data-field', 'note') // match title/desc so SSE renders defer while typing
  wrap.appendChild(input)
  items.appendChild(wrap)
  input.focus()
  let finished = false
  const done = (save) => {
    if (finished) return
    finished = true
    const text = input.textContent.trim()
    if (save && text) void elementOp(card.shortname, 'note', 'add', { text })
    else api.flushRender()
  }
  input.addEventListener('keydown', (ev) => {
    ev.stopPropagation()
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey || !ev.shiftKey)) {
      ev.preventDefault()
      done(true)
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      done(false)
    }
  })
  input.addEventListener('blur', () => done(true))
}

/** Apply a declarative element op (note/date/person edit, scratch, drop, add) via
 *  the engine. The surface sends intent; the engine reads → applyOp → writes → logs. */
function elementOp(shortname, type, op, { id, text } = {}) {
  return fetch(`/api/cards/${encodeURIComponent(shortname)}/op`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, op, id, text })
  }).then((r) => {
    if (!r.ok) console.error(`[board] element op ${type}.${op} failed: HTTP ${r.status}`)
    return r.ok
  })
}

/** Drop (delete) an output artifact file. Resolves true on success. */
function dropArtifact(card, file) {
  return fetch(
    `/api/artifacts/${encodeURIComponent(card.shortname)}/${encodeURIComponent(file)}`,
    { method: 'DELETE' }
  ).then((r) => {
    if (!r.ok) console.error(`[board] artifact drop failed: HTTP ${r.status}`)
    return r.ok
  })
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

/** Fill an expanded output's body with its rendered markdown (lazy-fetched, then
 *  cached). Visibility is owned by the render (the row's collapse state); this only
 *  loads content, so a re-render of an already-open row never re-fetches or flashes. */
async function loadOutputBody(el, card, file) {
  const body = el.querySelector(`[data-out-body="${CSS.escape(file)}"]`)
  if (!body || body.classList.contains('editing')) return
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
          : `could not load output (HTTP ${res.status})`
      } catch (err) {
        body.dataset.raw = `could not load output: ${err}`
      }
      artifactCache.set(key, body.dataset.raw)
    }
    body.innerHTML = renderMarkdown(body.dataset.raw)
  }
}

/** Edit an output in place: raw markdown, plaintext-editable, with an explicit
 *  Save/Cancel bar. Save (or clicking truly outside) commits + re-renders pretty;
 *  Cancel discards. All display/cache work is synchronous so it survives any
 *  board re-render the exit may trigger; the save POSTs in the background. */
async function editOutput(el, card, file) {
  const body = el.querySelector(`[data-out-body="${CSS.escape(file)}"]`)
  if (!body) return
  // Editing requires the body visible — reveal it (double-click may arrive collapsed).
  const out = body.closest('.editor-out')
  if (out) out.dataset.collapsed = 'false'
  body.hidden = false
  if (body.dataset.raw === undefined) await loadOutputBody(el, card, file)
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
