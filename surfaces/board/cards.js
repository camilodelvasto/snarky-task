/**
 * cards.js — pure render functions for the board surface.
 * No DOM access. All text goes through esc().
 */

// Palettes are design tokens — they live here, in the surface. WHICH label
// gets WHICH palette is data: config.json ui.accent_labels (label → palette
// name), falling back to DEFAULT_ACCENTS. Declaration order = precedence.
const PALETTES = {
  fire: [
    'linear-gradient(128deg,#ff1055 6%,#ff5c2e 60%,#ffb03d 112%)',
    'linear-gradient(128deg,#ff1055 0%,#ff7a3d 70%,#e5a50d 120%)',
    'linear-gradient(118deg,#d40d47 0%,#ff5c2e 55%,#ffb03d 105%)',
    'linear-gradient(138deg,#ff1055 10%,#ff4733 65%,#f2a007 115%)'
  ],
  violet: [
    'linear-gradient(128deg,#4f2bd9 6%,#8b47f6 60%,#d13df0 112%)',
    'linear-gradient(128deg,#4338ca 0%,#7c3aed 70%,#c026d3 120%)',
    'linear-gradient(118deg,#3b2fb8 0%,#8b5cf6 55%,#d946ef 105%)',
    'linear-gradient(138deg,#5b2bd9 10%,#7c4df0 65%,#b519e0 115%)'
  ]
}
export const DEFAULT_ACCENTS = { urgent: 'fire', important: 'violet' }

/**
 * The palette name for a card's first matching accent label, or null.
 * @param {{labels: string[]}} c
 * @param {Record<string,string>} [accents]
 * @returns {string|null}
 */
export function accentPalette(c, accents = DEFAULT_ACCENTS) {
  for (const [label, pal] of Object.entries(accents))
    if (c.labels.includes(label) && PALETTES[pal]) return pal
  return null
}

/**
 * Escape a value for safe interpolation into HTML.
 * @param {unknown} s
 * @returns {string}
 */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Whether a card carries the urgent or important label.
 * @param {import('../../src/main/tasks/types.ts').Card} c
 * @returns {boolean}
 */
export const isUrgent = (c, accents) => accentPalette(c, accents) !== null

/**
 * A card is a 'note' when it has no description, no artifacts, and at most one log entry
 * (the creation entry). Otherwise it's a 'post' with floating container styling.
 * @param {import('../../src/main/tasks/types.ts').Card} c
 * @returns {'note'|'post'}
 */
export const cardKind = (c) =>
  !c.description && c.artifacts.length === 0 && c.log.length <= 1 ? 'note' : 'post'

/**
 * Type-scale importance: urgent/important → hero; post → title; note → note.
 * @param {import('../../src/main/tasks/types.ts').Card} c
 * @returns {'hero'|'title'|'note'}
 */
export const importance = (c) => (isUrgent(c) ? 'hero' : cardKind(c) === 'post' ? 'title' : 'note')

/**
 * Deterministically pick one of the four gradient presets based on the shortname hash.
 * @param {string} shortname
 * @returns {string}
 */
export function gradientFor(shortname, palette = 'fire') {
  const grads = PALETTES[palette] ?? PALETTES.fire
  let h = 0
  for (const ch of shortname) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return grads[h % grads.length]
}

/**
 * Extract hh:mm from the last log entry for the meta line.
 * @param {string[]} log
 * @returns {string}
 */
function lastLogTime(log) {
  if (!log.length) return ''
  const last = log[log.length - 1]
  const m = String(last).match(/\d{2}:\d{2}/)
  return m ? m[0] : ''
}

/**
 * Format a date string (YYYY-MM-DD or ISO) as a short readable form.
 * @param {string|undefined} date
 * @returns {string}
 */
function shortDate(date) {
  if (!date) return ''
  // return as-is if already compact (e.g. YYYY-MM-DD)
  return String(date).slice(0, 10)
}

/**
 * Render a card for the surface or columns zone.
 * @param {import('../../src/main/tasks/types.ts').Card} c
 * @param {{ zone?: string, status?: string, draggable?: boolean, pending?: boolean }} opts
 *   — `status` lets the caller pass an optimistic display status (pendingMoves) so
 *     active-edge/meta track the target zone.
 *   — `draggable` adds draggable="true" + data-s for the columns drag-drop handlers.
 *   — `pending` adds the .pending class for optimistic-move graying.
 * @returns {string} HTML string
 */
export function renderCard(
  c,
  {
    zone: _zone = 'surface',
    status = c.status,
    draggable = false,
    pending = false,
    highlightLabels = [],
    accents = undefined,
    privateLabel = 'private',
    busy = false
  } = {}
) {
  const kind = cardKind(c)
  const pal = accentPalette(c, accents)
  const urgent = pal !== null
  const priv = c.labels.includes(privateLabel)
  const imp = importance(c)
  const titleClass = imp === 'hero' ? 't-hero' : imp === 'title' ? 't-title' : 't-note'
  const dragAttrs = draggable ? ` draggable="true" data-s="${esc(c.shortname)}"` : ''
  const pendingClass = pending ? ' pending' : ''

  if (kind === 'note') {
    const meta = c.due ? esc(shortDate(c.due)) : esc(shortDate(c.created))
    return (
      `<article class="card note${priv ? ' private' : ''}${pendingClass}${busy ? ' busy' : ''}" data-card="${esc(c.shortname)}" tabindex="-1"${dragAttrs}>` +
      `<button class="card-x" data-act="carddel" aria-label="delete" tabindex="-1">×</button>` +
      `<h3 class="${titleClass}">${esc(c.title)}</h3>` +
      (meta ? `<div class="t-meta m-faint">${meta}</div>` : '') +
      `</article>`
    )
  }

  // post
  const highlighted = c.labels.some((l) => highlightLabels.includes(l))
  const classes = [
    'card',
    'post',
    highlighted ? 'active-edge' : '',
    urgent ? `urgent grad-${pal}` : '',
    priv ? 'private' : '',
    busy ? 'busy' : '',
    pendingClass.trim()
  ]
    .filter(Boolean)
    .join(' ')

  const urgentStyle = urgent ? ` style="background:${gradientFor(c.shortname, pal)}"` : ''

  const bodyHtml = c.description ? `<p class="t-body clamp">${esc(c.description)}</p>` : ''

  const time = lastLogTime(c.log)
  const metaParts = [
    esc(status),
    c.artifacts.length
      ? `${c.artifacts.length} artifact${c.artifacts.length !== 1 ? 's' : ''}`
      : '',
    time
  ]
    .filter(Boolean)
    .join(' · ')

  // For urgent cards: override text color on meta via inline class
  const metaClass = urgent ? 't-meta urgent-meta' : 't-meta'

  return (
    `<article class="${classes}" data-card="${esc(c.shortname)}" tabindex="-1"${urgentStyle}${dragAttrs}>` +
    `<button class="card-x" data-act="carddel" aria-label="delete" tabindex="-1">×</button>` +
    `<h3 class="${titleClass}">${esc(c.title)}</h3>` +
    bodyHtml +
    (metaParts ? `<div class="${metaClass}">${metaParts}</div>` : '') +
    `</article>`
  )
}

/**
 * Render the EXPANDED card — a pure function of the card + display status.
 * Rendered in-flow by board.js whenever state.open === c.shortname; the same
 * declarative render pass that draws everything else draws this.
 *
 * Chrome: × close at top right; a STABLE action row derived from status —
 * backlog cards show the CLI command they emit (`promote #short`), active
 * cards show `done · drop`. The row never changes shape while open except
 * as a consequence of a state change (e.g. the promote landing).
 * @param {import('../../src/main/tasks/types.ts').Card} c
 * @param {{ status?: string }} opts
 * @returns {string} HTML string
 */
export function renderOpenCard(
  c,
  {
    status = c.status,
    highlightLabels = [],
    accents = undefined,
    privateLabel = 'private',
    busy = false,
    elementTypes = {},
    collapse = { sections: {}, outputs: {} },
    pendingUndo = null
  } = {}
) {
  const pal = accentPalette(c, accents)
  const urgent = pal !== null
  const highlighted = c.labels.some((l) => highlightLabels.includes(l))
  const imp = importance(c)
  const titleClass = imp === 'hero' ? 't-hero' : imp === 'title' ? 't-title' : 't-title'
  const urgentStyle = urgent ? ` style="background:${gradientFor(c.shortname, pal)}"` : ''

  const metaParts = [esc(status), c.due ? esc(shortDate(c.due)) : '', `#${esc(c.shortname)}`]
    .filter(Boolean)
    .join(' · ')

  // Card body is a set of typed content elements. We render each type's section
  // declaratively from `c.elements`, gating per-element actions on the type's
  // allowed ops (elementTypes). Unknown types are skipped, never fatal.
  const els = c.elements ?? []
  const ofType = (t) => els.filter((e) => e.type === t)
  const opsFor = (t) => elementTypes[t]?.ops ?? []

  // ── Content sections — ONE declarative pattern: ▸ name · N   write a X ─────
  // The whole header row toggles the section; state persists in `collapse`
  // (per card, per section). Notes keep their rich left-bar Garamond; outputs &
  // activity read as indented datetime-led lines sharing the `·` separator.
  // The write action appears only for a type whose ops include `add`.
  const secOpen = (k, def) => collapse?.sections?.[`${c.shortname}/${k}`] ?? def
  const outOpen = (file) => collapse?.outputs?.[`${c.shortname}/${file}`] ?? false

  const WRITE_LABEL = { 'write-note': 'write a note', 'write-output': 'write an output' }
  const renderSection = (key, label, count, writeAct, itemsHtml, open, itemsClass = '') => {
    const write = writeAct
      ? `<button class="editor-sec-write" data-act="${writeAct}">${WRITE_LABEL[writeAct]}</button>`
      : ''
    return (
      `<section class="editor-sec" data-sec="${key}" data-collapsed="${open ? 'false' : 'true'}">` +
      `<div class="editor-sec-head" data-act="toggle-sec" data-sec="${key}">` +
      `<span class="editor-sec-arrow">${open ? '▾' : '▸'}</span>` +
      `<span class="editor-sec-name">${label}</span>` +
      `<span class="editor-sec-count">· ${count}</span>` +
      write +
      `</div>` +
      `<div class="editor-sec-items ${itemsClass}">${itemsHtml}</div>` +
      `</section>`
    )
  }

  // Notes — rich: 2px left bar, 400/17 garamond, actions right-aligned on hover.
  const noteOps = opsFor('note')
  const renderNote = (e) => {
    const d = e.data ?? {}
    const sc = d.scratched ? ' scratched' : ''
    const act = (name, label) =>
      noteOps.includes(name === 'restore' ? 'scratch' : name)
        ? `<span class="editor-note-act" data-act="${name}">${label}</span>`
        : ''
    const actions = (
      d.scratched
        ? [act('restore', 'restore'), act('drop', 'drop')]
        : [act('scratch', 'scratch'), act('drop', 'drop')]
    ).filter(Boolean)
    return (
      `<div class="editor-note${sc}" data-el-id="${esc(e.id)}" data-el-type="note">` +
      `<div class="editor-note-text" data-field="note">${esc(d.text ?? '')}</div>` +
      `<div class="editor-note-foot"><span class="editor-note-time">${esc(d.at ?? '')}</span>` +
      `<span class="editor-note-acts">${actions.join('<span class="editor-note-sep"> · </span>')}</span></div>` +
      `</div>`
    )
  }
  const notesHtml = elementTypes.note
    ? renderSection(
        'notes',
        'notes',
        ofType('note').length,
        noteOps.includes('add') ? 'write-note' : null,
        ofType('note').map(renderNote).join(''),
        secOpen('notes', true),
        'notes'
      )
    : ''

  // Dates / People — quiet sections, same header pattern, no write.
  const renderElSection = (type, label, render) => {
    const items = ofType(type)
    if (!items.length) return ''
    const itemsHtml = items
      .map(
        (e) =>
          `<div class="editor-el-row" data-el-id="${esc(e.id)}" data-el-type="${type}">${render(e.data ?? {})}</div>`
      )
      .join('')
    return renderSection(type, label, items.length, null, itemsHtml, secOpen(type, true))
  }
  const datesHtml = renderElSection(
    'date',
    'dates',
    (d) => `${esc(d.on ?? '')}${d.label ? ` · ${esc(d.label)}` : ''}${d.text ? ` — ${esc(d.text)}` : ''}`
  )
  const peopleHtml = renderElSection(
    'person',
    'people',
    (d) => `${esc(d.ref ?? '')}${d.role ? ` · ${esc(d.role)}` : ''}`
  )

  // Outputs — datetime-led lines with an inline preview; the whole row opens the
  // full text (lazy-loaded by the editor) below. No left bar: distinct from notes.
  const outOps = opsFor('output')
  const renderOutput = (e) => {
    const d = e.data ?? {}
    const open = outOpen(d.file)
    const acts = []
    if (outOps.includes('edit'))
      acts.push(`<span class="editor-out-act" data-act="output-edit" data-file="${esc(d.file)}">edit</span>`)
    if (outOps.includes('drop'))
      acts.push(`<span class="editor-out-act" data-act="output-drop" data-file="${esc(d.file)}">drop</span>`)
    return (
      `<div class="editor-out" data-el-type="output" data-file="${esc(d.file)}" data-collapsed="${open ? 'false' : 'true'}">` +
      `<div class="editor-out-head" data-act="toggle-out" data-file="${esc(d.file)}">` +
      `<span class="editor-out-time t-meta">${esc(d.ts ?? d.file)}</span>` +
      `<span class="editor-mid-dot t-meta">·</span>` +
      `<span class="editor-out-preview t-body">${esc(d.preview ?? '')}</span>` +
      `<span class="editor-out-acts t-meta">${acts.join('<span class="editor-note-sep"> · </span>')}</span>` +
      `</div>` +
      `<div class="editor-out-body artifact-md" data-out-body="${esc(d.file)}" data-file="${esc(d.file)}"${open ? '' : ' hidden'}></div>` +
      `</div>`
    )
  }
  const outputsHtml = elementTypes.output
    ? renderSection(
        'output',
        'output',
        ofType('output').length,
        outOps.includes('add') ? 'write-output' : null,
        ofType('output').map(renderOutput).join(''),
        secOpen('output', true),
        'log'
      )
    : ''

  // Activity — the log; the latest drop surfaces an undo here (a command, like any
  // other). Display normalizes `<time> · <text>` regardless of the stored separator.
  const logEls = ofType('log')
  const renderLog = (line) => {
    const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s*(?:[—·–-]\s*)?(.*)$/)
    return m
      ? `<div class="editor-log-line t-meta"><span class="editor-log-time">${esc(m[1])}</span> · ${esc(m[2])}</div>`
      : `<div class="editor-log-line t-meta">${esc(line)}</div>`
  }
  const undoHtml =
    pendingUndo && pendingUndo.shortname === c.shortname
      ? `<div class="editor-log-line undo t-meta"><span class="editor-undo-label">${esc(pendingUndo.label)} dropped</span><span class="editor-undo-act" data-act="undo">undo</span></div>`
      : ''
  const activityHtml =
    logEls.length || undoHtml
      ? renderSection(
          'activity',
          'activity',
          logEls.length,
          null,
          undoHtml + logEls.map((e) => renderLog(e.data?.line ?? '')).join(''),
          secOpen('activity', false),
          'log'
        )
      : ''

  // Status-derived, stable action row. Backlog → the CLI command it will emit.
  // Backlog cards lead with the promote command but keep the full exits —
  // a backlog task can be finished or dropped without passing through active.
  const doneDrop =
    `<button class="t-meta open-act" data-act="done">done</button>` +
    `<span class="t-meta open-sep">·</span>` +
    `<button class="t-meta open-act" data-act="drop">drop</button>`
  const actions =
    status === 'inbox' || status === 'waiting'
      ? `<button class="t-meta open-act promote" data-act="promote">›_ promote #${esc(c.shortname)}</button>` +
        `<span class="t-meta open-sep">·</span>` +
        doneDrop
      : doneDrop

  return (
    `<article class="card editor-card card-open${urgent ? ` urgent grad-${pal}` : ''}${highlighted ? ' active-edge' : ''}${busy ? ' busy' : ''}" data-card="${esc(c.shortname)}" data-open-card tabindex="-1">` +
    // Header band — the ONLY place the urgent/important gradient lives; the body
    // below stays on paper so the card never reads as a heavy slab of color.
    `<div class="editor-header"${urgentStyle}>` +
    `<button class="x-close" data-act="close" aria-label="close">×</button>` +
    `<div class="editor-field-wrap">` +
    `<div class="${titleClass} editor-title" data-field="title" contenteditable="plaintext-only" spellcheck="false" aria-label="title">${esc(c.title)}</div>` +
    `</div>` +
    `</div>` +
    `<div class="editor-body">` +
    // The description/body lives here, on paper — always editable, with room to
    // write, on any card (no Claude output required). Click and type.
    `<div class="editor-field-wrap editor-desc-wrap">` +
    `<div class="t-body editor-desc" data-field="description" contenteditable="plaintext-only" spellcheck="false" aria-label="description">${esc(c.description ?? '')}</div>` +
    `</div>` +
    `<div class="t-meta editor-meta">${metaParts}</div>` +
    `<div class="editor-labels">` +
    // System labels (declared in config + the gradient pair + private) render as
    // toggles — visible even when off, so they are discoverable.
    [...new Set([...highlightLabels, ...Object.keys(accents ?? DEFAULT_ACCENTS), privateLabel])]
      .map((l) => {
        const on = c.labels.includes(l)
        const priv = l === privateLabel ? ' priv' : ''
        return `<button class="lbl sys${priv}${on ? ' on' : ''}" data-act="togglelabel" data-tag="${esc(l)}" aria-pressed="${on}">#${esc(l)}</button>`
      })
      .join('') +
    c.labels
      .filter(
        (l) =>
          !highlightLabels.includes(l) && l !== 'urgent' && l !== 'important' && l !== privateLabel
      )
      .map(
        (l) =>
          `<span class="lbl">#${esc(l)}<button class="lbl-x" data-act="untag" data-tag="${esc(l)}" aria-label="remove ${esc(l)}">×</button></span>`
      )
      .join('') +
    `<button class="t-meta lbl-add" data-act="addtag">+ tag</button>` +
    `</div>` +
    notesHtml +
    datesHtml +
    peopleHtml +
    outputsHtml +
    activityHtml +
    `<div class="editor-hairline"></div>` +
    `<div class="editor-actions">${actions}</div>` +
    `</div>` + // .editor-body
    `</article>`
  )
}

/**
 * Render a rail item (backlog row) for the right-side rail.
 * @param {import('../../src/main/tasks/types.ts').Card} c
 * @returns {string} HTML string
 */
export function renderRailItem(c, { busy = false } = {}) {
  const meta =
    c.status === 'waiting'
      ? `waiting · ${c.due ? esc(shortDate(c.due)) : '—'}`
      : esc(shortDate(c.created))

  return (
    `<div class="rail-item${busy ? ' busy' : ''}" data-card="${esc(c.shortname)}" data-s="${esc(c.shortname)}" draggable="true" tabindex="-1">` +
    `<span class="t-note rail-title">${esc(c.title)}</span>` +
    `<span class="t-meta">${meta}</span>` +
    `</div>`
  )
}
