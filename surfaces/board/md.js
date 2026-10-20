/**
 * md.js — tiny offline markdown renderer for artifact display.
 * Escapes everything first, then transforms: headings, bold/italic/code,
 * fenced code, lists, tables, blockquotes, hr, links (rendered as text —
 * the shell must not navigate away). Good-enough for delegation output;
 * not a spec-complete parser.
 */

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function inline(s) {
  return s
    .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[\s(])_([^_\s][^_]*)_(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, t, u) => `<span class="md-link" title="${u}">${t}</span>`
    )
}

/**
 * @param {string} src raw markdown
 * @returns {string} HTML
 */
export function renderMarkdown(src) {
  const lines = String(src ?? '').split('\n')
  const out = []
  let i = 0
  const para = []
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(' '))}</p>`)
      para.length = 0
    }
  }

  while (i < lines.length) {
    const raw = lines[i]
    const line = esc(raw.trimEnd())
    const t = line.trim()

    // fenced code
    if (/^```/.test(t)) {
      flushPara()
      const buf = []
      i++
      while (i < lines.length && !/^```/.test(lines[i].trim())) buf.push(esc(lines[i++]))
      i++ // closing fence
      out.push(`<pre class="md-pre">${buf.join('\n')}</pre>`)
      continue
    }
    // blank
    if (t === '') {
      flushPara()
      i++
      continue
    }
    // heading
    const h = t.match(/^(#{1,4})\s+(.*)$/)
    if (h) {
      flushPara()
      out.push(`<div class="md-h${h[1].length}">${inline(h[2])}</div>`)
      i++
      continue
    }
    // hr
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara()
      out.push('<div class="md-hr"></div>')
      i++
      continue
    }
    // blockquote
    if (t.startsWith('&gt;')) {
      flushPara()
      const buf = []
      while (i < lines.length && esc(lines[i].trim()).startsWith('&gt;'))
        buf.push(inline(esc(lines[i++].trim()).replace(/^&gt;\s?/, '')))
      out.push(`<blockquote>${buf.join('<br>')}</blockquote>`)
      continue
    }
    // table: a | row followed by a |---| separator
    if (t.startsWith('|') && i + 1 < lines.length && /^\|[\s|:-]+\|?$/.test(lines[i + 1].trim())) {
      flushPara()
      const cells = (l) =>
        esc(l.trim())
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => inline(c.trim()))
      const head = cells(lines[i])
      i += 2
      const rows = []
      while (i < lines.length && lines[i].trim().startsWith('|')) rows.push(cells(lines[i++]))
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
      )
      continue
    }
    // lists (single level)
    const ul = t.match(/^[-*]\s+(.*)$/)
    const ol = t.match(/^\d+\.\s+(.*)$/)
    if (ul || ol) {
      flushPara()
      const tag = ul ? 'ul' : 'ol'
      const items = []
      while (i < lines.length) {
        const m = ul
          ? lines[i].trim().match(/^[-*]\s+(.*)$/)
          : lines[i].trim().match(/^\d+\.\s+(.*)$/)
        if (!m) break
        items.push(`<li>${inline(esc(m[1]))}</li>`)
        i++
      }
      out.push(`<${tag}>${items.join('')}</${tag}>`)
      continue
    }
    // paragraph text
    para.push(t)
    i++
  }
  flushPara()
  return out.join('')
}
