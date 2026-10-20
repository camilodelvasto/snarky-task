const rows = document.getElementById('rows')
const done = document.getElementById('done')
const input = document.getElementById('input')
const form = document.getElementById('prompt')
const complete = document.getElementById('complete')

// Cmd/Ctrl+K lands here from the main process (views.ts): focus the console
// line with the caret at the end — works from either surface.
window.__focusConsole = () => {
  input.focus()
  input.setSelectionRange(input.value.length, input.value.length)
}

let cards = []
let lastInstructions = []
let histOpen = false
let histData = []
// terminal-style command recall (ArrowUp/Down in the prompt)
let recallIdx = -1
let recallDraft = ''
let recallList = []

async function buildRecall() {
  if (!histData.length) {
    try {
      const res = await fetch('/api/history')
      histData = res.ok ? await res.json() : []
    } catch {
      histData = []
    }
  }
  const raws = [...[...lastInstructions].reverse().map((i) => i.raw), ...histData.map((i) => i.raw)]
  // collapse consecutive duplicates, shell-style
  recallList = raws.filter((r, i) => r && r !== raws[i - 1])
}
let lastSnapshot = { instructions: [], cards: [] }
const expanded = new Set() // instruction ids with an open drawer

/**
 * Escape a string for safe interpolation into HTML.
 * @param {unknown} s
 * @returns {string}
 */
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * @param {string} url
 * @param {Object} body
 * @returns {Promise<Response>}
 */
function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

const STATUS_LABEL = {
  queued: 'queued',
  working: 'working',
  needs_confirmation: 'confirm?',
  attention: 'attention',
  done: 'done'
}

/** Instruction ids encode their timestamp: "2026-10-03T07-04-52-bf1e" → "07:04" */
function timeOf(id) {
  const m = String(id).match(/T(\d{2})-(\d{2})/)
  return m ? `${m[1]}:${m[2]}` : ''
}

const ICONS = {
  check: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 7.5l3 3 6-7"/></svg>`,
  x: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7"/></svg>`,
  pencil: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2l2 2-7.5 7.5L2 12l.5-2.5zM8.5 3.5l2 2"/></svg>`,
  trash: `<svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 4h9M5.5 4V2.5h3V4M4 4l.5 7.5h5L10 4M6 6.5v3M8 6.5v3"/></svg>`
}

/**
 * @param {Object} inst
 * @returns {string}
 */
function rowActions(inst) {
  if (inst.status === 'needs_confirmation')
    return (
      `<button class="icon-btn ok" data-act="confirm" title="confirm">${ICONS.check}</button>` +
      `<button class="icon-btn danger" data-act="reject" title="reject">${ICONS.x}</button>`
    )
  if (inst.status === 'attention')
    return (
      `<button class="icon-btn" data-act="edit" title="edit &amp; requeue">${ICONS.pencil}</button>` +
      `<button class="icon-btn danger" data-act="delete" title="delete">${ICONS.trash}</button>`
    )
  return ''
}

/** Human duration: 740 → "740ms", 12400 → "12.4s". */
function fmtMs(ms) {
  if (ms === undefined || ms === null) return '—'
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** Inline execution drawer — task-oriented runtime facts, not the card. */
function drawerHtml(i) {
  const kv = (k, v, cls = '') =>
    `<div class="kv${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`
  // A queued instruction whose card has a parked attention is frozen-blocked —
  // say so, instead of looking silently stuck.
  const blockedBy = blockedByAttention(i)
  return `
    <div class="drawer" data-id="${esc(i.id)}">
      ${kv('engine', esc(i.engine ?? '—'))}
      ${kv('model', esc(i.model ?? '—'))}
      ${i.version ? kv('version', esc(i.version)) : ''}
      ${kv('duration', esc(fmtMs(i.ms)))}
      ${kv('queued', esc(timeOf(i.id)))}
      ${i.action ? kv('action', esc(i.action)) : ''}
      ${i.card ? kv('card', `#${esc(i.card)}${i.pick ? ` <span class="pick">← ${esc((i.engine ?? '').replace(/^cli\+/, '') || 'resolver')} ${Number(i.pick).toFixed(2)}</span>` : ''}`) : ''}
      ${kv('instruction', `<span class="raw-full">${esc(i.raw)}</span>`, ' wide')}
      ${i.error ? kv('error', `<span class="err-v">${esc(i.error)}</span>`, ' wide') : ''}
      ${i.result ? kv('result', `<span class="result-v">${esc(i.result)}</span>`, ' wide') : ''}
      ${blockedBy ? kv('blocked', `<span class="err-v">waiting — resolve the attention on #${esc(i.card)} first (${esc(timeOf(blockedBy.id))})</span>`, ' wide') : ''}
    </div>`
}

function blockedByAttention(i) {
  return i.status === 'queued' && i.card
    ? lastInstructions.find((o) => o.status === 'attention' && o.card === i.card)
    : null
}

function rowHtml(i) {
  const via =
    i.via === 'cli'
      ? '<span class="via cli" title="command">›_</span>'
      : i.via === 'ai'
        ? '<span class="via ai" title="resolver">✦</span>'
        : i.via === 'cli+ai'
          ? '<span class="via cli" title="command — card picked by resolver">›_✦</span>'
          : ''
  const isOpen = expanded.has(i.id)
  return `
    <div class="row ${esc(i.status)}${isOpen ? ' expanded' : ''}" data-id="${esc(i.id)}">
      <span class="pill s-${esc(i.status)}">${esc(STATUS_LABEL[i.status] ?? i.status)}</span>
      ${via}<span class="raw">${esc(i.raw)}</span>
      ${i.error ? `<span class="err">${esc(i.error)}</span>` : ''}
      ${blockedByAttention(i) ? `<span class="blk">blocked by #${esc(i.card)}</span>` : ''}
      <span class="actions">${rowActions(i)}</span>
      <span class="time">${esc(timeOf(i.id))}</span>
    </div>${isOpen ? drawerHtml(i) : ''}`
}

/**
 * @param {Object} snapshot
 * @returns {void}
 */
let byePending = false

function render(snapshot) {
  // Don't clobber an active inline edit — the next snapshot update will catch up.
  if (document.activeElement && document.activeElement.classList.contains('edit-input')) return
  lastSnapshot = snapshot
  // Graceful exit: rows leaving the DOM (auto-swept, cleaned, cleared) fade
  // and collapse for one beat before the re-render removes them.
  const nextIds = new Set(
    snapshot.instructions.map((i) => i.id).concat(histOpen ? histData.map((i) => i.id) : [])
  )
  const leaving = [...document.querySelectorAll('.row[data-id]')].filter(
    (el) => !nextIds.has(el.dataset.id) && !el.classList.contains('bye')
  )
  if (leaving.length && !byePending) {
    byePending = true
    for (const el of leaving) {
      const targets = [el]
      if (el.nextElementSibling?.classList.contains('drawer')) targets.push(el.nextElementSibling)
      for (const t of targets) {
        t.style.maxHeight = `${t.offsetHeight}px`
        void t.offsetHeight // commit the start height before transitioning
        t.classList.add('bye')
      }
    }
    setTimeout(() => {
      byePending = false
      render(lastSnapshot)
    }, 330)
    return
  }
  cards = snapshot.cards
  lastInstructions = snapshot.instructions
  const open = snapshot.instructions.filter((i) => i.status !== 'done')
  const finished = snapshot.instructions.filter((i) => i.status === 'done')
  rows.innerHTML = open.map(rowHtml).join('')
  const histToggle = `<button class="hist-toggle" data-hist>history ${histOpen ? '▾' : '▸'}</button>`
  const histRows = histOpen ? histData.map(rowHtml).join('') : ''
  done.innerHTML =
    `<div class="done-head">${histToggle}${
      finished.length ? ` · ${finished.length} done — "clean" sweeps to history, "clear" wipes` : ''
    }</div>` +
    histRows +
    (finished.length ? finished.map(rowHtml).join('') : '')
}

async function toggleHistory() {
  histOpen = !histOpen
  if (histOpen) {
    try {
      const res = await fetch('/api/history')
      histData = res.ok ? await res.json() : []
    } catch {
      histData = []
    }
  }
  render(lastSnapshot)
}

done.addEventListener('click', (e) => {
  if (e.target.closest('[data-hist]')) {
    e.stopPropagation()
    void toggleHistory()
  }
})

/** Clicking a row expands it in place — a drawer with execution facts, not a modal. */
function toggleDrawer(id) {
  if (expanded.has(id)) expanded.delete(id)
  else expanded.add(id)
  render(lastSnapshot)
  if (expanded.has(id)) {
    requestAnimationFrame(() => {
      rows
        .querySelector(`.drawer[data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    })
  }
}

async function handleRowClick(e, container) {
  const row = e.target.closest('.row')
  if (!row || !container.contains(row)) return
  const id = row.dataset.id
  const btn = e.target.closest('button')
  if (!btn) {
    if (id) toggleDrawer(id)
    return
  }
  const act = btn.dataset.act
  if (act === 'edit') {
    const rawSpan = row.querySelector('.raw')
    const originalText = rawSpan.textContent

    // Replace span with input
    const editInput = document.createElement('input')
    editInput.className = 'edit-input'
    editInput.value = originalText
    rawSpan.replaceWith(editInput)

    editInput.focus()
    editInput.select()

    // Handle Enter key
    const handleEnter = async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        const text = editInput.value.trim()
        if (text) {
          await post(`/api/instructions/${id}`, { action: 'requeue', text })
        }
        editInput.removeEventListener('keydown', handleEnter)
        editInput.removeEventListener('keydown', handleEscape)
        // Exit edit mode explicitly — render() skips re-renders while an edit input is
        // focused, so leaving it in place would deadlock the feed against its own guard.
        editInput.remove()
        void refreshState()
      }
    }

    // Handle Escape key
    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        const newRawSpan = document.createElement('span')
        newRawSpan.className = 'raw'
        newRawSpan.textContent = originalText
        editInput.replaceWith(newRawSpan)
        editInput.removeEventListener('keydown', handleEnter)
        editInput.removeEventListener('keydown', handleEscape)
      }
    }

    editInput.addEventListener('keydown', handleEnter)
    editInput.addEventListener('keydown', handleEscape)
    return
  }
  const res = await post(`/api/instructions/${id}`, { action: act })
  // A failed action (e.g. the row's id went stale after a requeue) means the DOM has
  // drifted from the files — refetch so ghosts self-heal instead of lingering.
  if (!res.ok) void refreshState()
}

async function refreshState() {
  const r = await fetch('/api/state')
  render(await r.json())
}

rows.addEventListener('click', (e) => handleRowClick(e, rows))
done.addEventListener('click', (e) => handleRowClick(e, done))

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  recallIdx = -1
  recallDraft = ''
  autogrow()
  // "yes"/"no" shortcuts: if the user types exactly "yes" or "no" and there is at least one
  // needs_confirmation instruction, confirm/reject the oldest one instead of creating a new
  // instruction. This lets the user respond to destructive-action gates from the keyboard
  // without having to click the confirm/reject buttons.
  const lower = text.toLowerCase()
  if (lower === 'yes' || lower === 'no') {
    const pending = lastInstructions.filter((i) => i.status === 'needs_confirmation')
    if (pending.length > 0) {
      const oldest = pending[0]
      await post(`/api/instructions/${oldest.id}`, {
        action: lower === 'yes' ? 'confirm' : 'reject'
      })
      return
    }
  }
  await post('/api/instructions', { text })
})

// The prompt is a textarea so long instructions wrap and grow; Enter submits,
// Shift+Enter inserts a newline.
function autogrow() {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
}

// Autocomplete — arrows move the selection, Tab accepts.
// Hits are {insert, label, hint} objects for all trigger types.
// Trigger dispatch:
//   /word  at position 0  → verb completions
//   $word  at end         → status completions
//   @word  at end         → collaborator completions
//   #word  at end         → card shortname completions (original behaviour)
//   project / /project    → subcommand + name completions
// acTrigger tracks which trigger fired so acceptHit branches on that, not the input text.
let acHits = []
let acSel = 0
/** @type {'verb'|'status'|'collab'|'card'|'proj'|null} */
let acTrigger = null

// Static verb list — insert adds a trailing space so the user keeps typing.
// Aliases shown in the hint string.
const AC_VERBS = [
  { insert: 'create ', label: '/create', hint: 'new — <title> [$status] [#tag] [@collab]' },
  { insert: 'move ', label: '/move', hint: 'mv — <#card> $status' },
  { insert: 'promote ', label: '/promote', hint: 'upgrade — <#card> to active' },
  { insert: 'backlog ', label: '/backlog', hint: 'downgrade, demote — <#card> to backlog' },
  { insert: 'tag ', label: '/tag', hint: '<#card> <#tag…> — add labels' },
  { insert: 'untag ', label: '/untag', hint: '<#card> <#tag…> — remove labels' },
  { insert: 'highlight ', label: '/highlight', hint: '<#card> — toggle the highlight label' },
  { insert: 'unhighlight ', label: '/unhighlight', hint: '<#card> — remove it' },
  { insert: 'note ', label: '/note', hint: 'log — <#card> <text>' },
  { insert: 'link ', label: '/link', hint: '<#card> <#card>' },
  { insert: 'delete ', label: '/delete', hint: 'del, rm — <#card>' },
  { insert: 'delegate ', label: '/delegate', hint: '<#card> @collab [text]' },
  { insert: 'open ', label: '/open', hint: 'expand — <#card> opens it on the board' },
  { insert: 'rename ', label: '/rename', hint: '<#card> <new title> — slug follows' },
  { insert: 'project ', label: '/project', hint: 'switch/new/rm — decks per concern' },
  { insert: 'projects', label: '/projects', hint: 'list projects' },
  { insert: 'clean', label: '/clean', hint: 'sweep done rows into history' },
  { insert: 'clear', label: '/clear', hint: 'wipe history and done rows' }
]

// Static status list.
const AC_STATUSES = ['inbox', 'active', 'waiting', 'done', 'dropped'].map((s) => ({
  insert: '$' + s + ' ',
  label: '$' + s,
  hint: ''
}))

// Static collaborator list — keep in sync with workspace/tasks/config.json collaborators.
const AC_COLLABS = ['claude', 'local'].map((c) => ({
  insert: '@' + c + ' ',
  label: '@' + c,
  hint: ''
}))

function renderComplete() {
  complete.hidden = acHits.length === 0
  complete.innerHTML = acHits
    .map(
      (h, i) =>
        `<div class="hit${i === acSel ? ' sel' : ''}" data-idx="${i}">${esc(h.label)}${h.hint ? ` <em>${esc(h.hint)}</em>` : ''}</div>`
    )
    .join('')
}

/** Replace the matched tail in the input and close the menu. */
function acceptHit(hit) {
  const val = input.value
  // Branch on which trigger populated acHits, NOT on the current input text.
  // Re-testing the text is unsafe: e.g. `project something #card` would
  // match the proj pattern while the card trigger is active.
  if (acTrigger === 'verb') {
    // /word at position 0 — replace the whole input.
    input.value = hit.insert
  } else if (acTrigger === 'proj') {
    // Project sub-completion: hit.insert is the full replacement line.
    input.value = hit.insert
  } else {
    // 'status', 'collab', 'card' — replace the last $word, @word, or #word tail.
    input.value = val.replace(/[$@#][a-z0-9-]*$/i, hit.insert)
  }
  acHits = []
  acTrigger = null
  complete.hidden = true
  autogrow()
  input.focus()
}

input.addEventListener('keydown', (e) => {
  if (!complete.hidden && acHits.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      acSel = (acSel + 1) % acHits.length
      renderComplete()
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      acSel = (acSel - 1 + acHits.length) % acHits.length
      renderComplete()
      return
    }
    if (e.key === 'Tab') {
      // Tab is the ONLY accept key. Enter always submits (below), even with the
      // menu open — so a new value that happens to share a prefix with an
      // existing card (`#private` vs card `#private-keys`) can be committed
      // without being hijacked into the suggestion.
      e.preventDefault()
      acceptHit(acHits[acSel])
      return
    }
    if (e.key === 'Escape') {
      acHits = []
      acTrigger = null
      complete.hidden = true
      return
    }
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    // Submitting dismisses any open suggestion menu — it was only a hint.
    acHits = []
    acTrigger = null
    complete.hidden = true
    form.requestSubmit()
    return
  }

  // ── Terminal recall: ↑ on the first line walks back through past commands ──
  const caret = input.selectionStart ?? 0
  const beforeCaret = input.value.slice(0, caret)
  if (e.key === 'ArrowUp' && !beforeCaret.includes('\n')) {
    e.preventDefault()
    void (async () => {
      if (recallIdx === -1) {
        await buildRecall()
        recallDraft = input.value
      }
      if (recallIdx < recallList.length - 1) {
        recallIdx++
        input.value = recallList[recallIdx]
        autogrow()
        input.setSelectionRange(input.value.length, input.value.length)
      }
    })()
    return
  }
  if (e.key === 'ArrowDown' && recallIdx >= 0 && !input.value.slice(caret).includes('\n')) {
    e.preventDefault()
    recallIdx--
    input.value = recallIdx === -1 ? recallDraft : recallList[recallIdx]
    autogrow()
    input.setSelectionRange(input.value.length, input.value.length)
    return
  }
})

input.addEventListener('input', () => {
  recallIdx = -1
  autogrow()
  const val = input.value

  // Verb trigger: / at position 0 only.
  if (/^\/(\w*)$/.test(val)) {
    const prefix = val.slice(1).toLowerCase()
    acHits = AC_VERBS.filter((v) => v.label.slice(1).startsWith(prefix))
    acSel = 0
    acTrigger = 'verb'
    renderComplete()
    return
  }

  // Status trigger: $word at end.
  const mStatus = val.match(/\$([a-z0-9-]*)$/i)
  if (mStatus) {
    const prefix = mStatus[1].toLowerCase()
    acHits = AC_STATUSES.filter((s) => s.label.slice(1).startsWith(prefix))
    acSel = 0
    acTrigger = 'status'
    renderComplete()
    return
  }

  // Collaborator trigger: @word at end.
  const mCollab = val.match(/@([a-z0-9-]*)$/i)
  if (mCollab) {
    const prefix = mCollab[1].toLowerCase()
    acHits = AC_COLLABS.filter((c) => c.label.slice(1).startsWith(prefix))
    acSel = 0
    acTrigger = 'collab'
    renderComplete()
    return
  }

  // Card shortname trigger: #word at end (original behaviour).
  const mCard = val.match(/#([a-z0-9-]*)$/i)
  if (mCard) {
    const prefix = mCard[1].toLowerCase()
    // Only live cards — never suggest archived (done/dropped) ones.
    acHits = cards
      .filter((c) => c.status !== 'done' && c.status !== 'dropped')
      .filter((c) => c.shortname.startsWith(prefix))
      .slice(0, 6)
      .map((c) => ({ insert: '#' + c.shortname + ' ', label: '#' + c.shortname, hint: c.title }))
    acSel = 0
    acTrigger = 'card'
    renderComplete()
    return
  }

  // Project trigger: "project " or "/project " at the start — offer subcommands,
  // project names, and (after "new <name> from ") template names.
  const mProj = val.match(/^\/?(project\s+)(.*)/i)
  if (mProj) {
    const tail = mProj[2]
    const proj = lastSnapshot.project
    // "new <name> from <prefix>" — offer template names
    const mFrom = tail.match(/^new\s+\S+\s+from\s+(\S*)$/i)
    if (mFrom) {
      const prefix = mFrom[1].toLowerCase()
      const templates = proj?.templates ?? []
      acHits = templates
        .filter((t) => t.startsWith(prefix))
        .map((t) => ({ insert: val.replace(/\S*$/, t + ' '), label: t, hint: 'template' }))
      acSel = 0
      acTrigger = 'proj'
      renderComplete()
      return
    }
    // "new <prefix>" — no further completions here (name is free-form)
    // project names: offer matching names after "project <prefix>"
    const mName = tail.match(/^([a-z0-9-]*)$/i)
    if (mName) {
      const prefix = mName[1].toLowerCase()
      const names = proj?.list ?? []
      const subCmds = [
        { insert: val.replace(/\S*$/, 'new '), label: 'new', hint: 'create a project' },
        { insert: val.replace(/\S*$/, 'rm '), label: 'rm', hint: 'remove a project' }
      ].filter((s) => s.label.startsWith(prefix))
      const nameHits = names
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ insert: val.replace(/\S*$/, n + ' '), label: n, hint: 'switch to project' }))
      acHits = [...subCmds, ...nameHits]
      acSel = 0
      acTrigger = 'proj'
      renderComplete()
      return
    }
    acHits = []
    acTrigger = null
    complete.hidden = true
    return
  }

  acHits = []
  acTrigger = null
  complete.hidden = true
})

complete.addEventListener('mousedown', (e) => {
  const hit = e.target.closest('.hit')
  if (!hit) return
  const idx = Number(hit.dataset.idx)
  if (!Number.isNaN(idx) && acHits[idx]) acceptHit(acHits[idx])
})

const events = new EventSource('/api/events')
events.onmessage = (e) => render(JSON.parse(e.data))
void fetch('/api/state')
  .then((r) => r.json())
  .then(render)
