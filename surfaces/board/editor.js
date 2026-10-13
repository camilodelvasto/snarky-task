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
      if (file) void toggleArtifact(el, card, file)
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

/** Toggle (and lazily fetch) an artifact's content below its row. */
async function toggleArtifact(el, card, file, { forceOpen = false } = {}) {
  const body = el.querySelector(`[data-artifact-body="${CSS.escape(file)}"]`)
  if (!body) return
  if (!body.hidden && !forceOpen) {
    body.hidden = true
    return
  }
  if (!body.textContent) {
    try {
      const res = await fetch(
        `/api/artifacts/${encodeURIComponent(card.shortname)}/${encodeURIComponent(file)}`
      )
      body.textContent = res.ok ? await res.text() : `could not load artifact (HTTP ${res.status})`
    } catch (err) {
      body.textContent = `could not load artifact: ${err}`
    }
  }
  body.hidden = false
}
