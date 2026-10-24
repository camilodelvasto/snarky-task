import { describe, it, expect } from 'vitest'
import { textShape } from '../tasks/elements/text'
import { noteShape } from '../tasks/elements/note'
import { logShape } from '../tasks/elements/log'
import { dateShape } from '../tasks/elements/date'
import { personShape } from '../tasks/elements/person'

describe('textShape', () => {
  it('has correct metadata', () => {
    expect(textShape.type).toBe('text')
    expect(textShape.schema).toBe('text.v1.json')
    expect(textShape.storage).toBe('body')
    expect(textShape.lead).toBe(true)
    expect(textShape.ops).toEqual(['edit'])
    expect(textShape.section).toBeUndefined()
  })

  it('parse returns lead id and text data', () => {
    const result = textShape.parse!('line one\nline two')
    expect(result).toEqual({ id: 'lead', data: { text: 'line one\nline two' } })
  })

  it('parse trims trailing whitespace from block', () => {
    const result = textShape.parse!('hello world  \n')
    expect(result).toEqual({ id: 'lead', data: { text: 'hello world' } })
  })

  it('render returns text string without decoration', () => {
    const el = { id: 'lead', type: 'text', data: { text: 'line one\nline two' } }
    expect(textShape.render!(el)).toBe('line one\nline two')
  })

  it('round-trips multi-line text', () => {
    const original = 'line one\nline two'
    const parsed = textShape.parse!(original)
    const rendered = textShape.render!({ id: parsed.id, type: 'text', data: parsed.data })
    expect(rendered).toBe(original)
  })
})

describe('noteShape', () => {
  it('has correct metadata', () => {
    expect(noteShape.type).toBe('note')
    expect(noteShape.schema).toBe('note.v1.json')
    expect(noteShape.storage).toBe('body')
    expect(noteShape.section).toBe('Notes')
    expect(noteShape.ops).toEqual(['add', 'edit', 'scratch', 'drop'])
    expect(noteShape.lead).toBeUndefined()
  })

  it('round-trips a plain note', () => {
    const el = { id: 'n1a2', type: 'note', data: { at: '2026-10-22T10:00:00Z', text: 'call the plumber' } }
    const rendered = noteShape.render!(el)
    expect(rendered).toBe('- n1a2 · 2026-10-22T10:00:00Z — call the plumber')
    const parsed = noteShape.parse!(rendered)
    expect(parsed.id).toBe('n1a2')
    expect(parsed.data.at).toBe('2026-10-22T10:00:00Z')
    expect(parsed.data.text).toBe('call the plumber')
    expect(parsed.data.scratched).toBeUndefined()
  })

  it('round-trips a scratched note', () => {
    const el = { id: 'n9z3', type: 'note', data: { at: '2026-10-22T11:00:00Z', text: 'buy milk', scratched: true } }
    const rendered = noteShape.render!(el)
    expect(rendered).toBe('- n9z3 · 2026-10-22T11:00:00Z · scratched — buy milk')
    const parsed = noteShape.parse!(rendered)
    expect(parsed.id).toBe('n9z3')
    expect(parsed.data.at).toBe('2026-10-22T11:00:00Z')
    expect(parsed.data.text).toBe('buy milk')
    expect(parsed.data.scratched).toBe(true)
  })

  it('text containing " — " and " · " only uses the FIRST separators structurally', () => {
    const text = 'first — second · third — fourth'
    const el = { id: 'nabcd', type: 'note', data: { at: '2026-10-22T12:00:00Z', text } }
    const rendered = noteShape.render!(el)
    // The rendered form: "- nabcd · 2026-10-22T12:00:00Z — first — second · third — fourth"
    expect(rendered).toBe(`- nabcd · 2026-10-22T12:00:00Z — ${text}`)
    const parsed = noteShape.parse!(rendered)
    expect(parsed.id).toBe('nabcd')
    expect(parsed.data.at).toBe('2026-10-22T12:00:00Z')
    expect(parsed.data.text).toBe(text)
    expect(parsed.data.scratched).toBeUndefined()
  })

  it('round-trips a multi-line note (continuation lines joined with \\n)', () => {
    const text = 'first line\nsecond line\nthird line'
    const el = { id: 'nm001', type: 'note', data: { at: '2026-10-22T13:00:00Z', text } }
    // render emits the folded form (first line is the header, continuation lines follow)
    const rendered = noteShape.render!(el)
    expect(rendered).toBe('- nm001 · 2026-10-22T13:00:00Z — first line\nsecond line\nthird line')
    const parsed = noteShape.parse!(rendered)
    expect(parsed.id).toBe('nm001')
    expect(parsed.data.at).toBe('2026-10-22T13:00:00Z')
    expect(parsed.data.text).toBe(text)
  })

  it('hand-typed id-less line parses with id="" and correct text', () => {
    const parsed = noteShape.parse!('- just a thought')
    expect(parsed.id).toBe('')
    expect(parsed.data.text).toBe('just a thought')
  })
})

describe('logShape', () => {
  it('has correct metadata', () => {
    expect(logShape.type).toBe('log')
    expect(logShape.schema).toBe('log.v1.json')
    expect(logShape.storage).toBe('body')
    expect(logShape.section).toBe('Log')
    expect(logShape.ops).toEqual(['append'])
    expect(logShape.system).toBe(true)
  })

  it('round-trips a log line', () => {
    const line = '2026-10-22 08:14 — created'
    const el = { id: line, type: 'log', data: { line } }
    const rendered = logShape.render!(el)
    expect(rendered).toBe(`- ${line}`)
    const parsed = logShape.parse!(rendered)
    expect(parsed.id).toBe(line)
    expect(parsed.data.line).toBe(line)
  })

  it('content-identity: identical lines yield the same id', () => {
    const line = '2026-10-22 08:14 — created'
    const parsed1 = logShape.parse!(`- ${line}`)
    const parsed2 = logShape.parse!(`- ${line}`)
    expect(parsed1.id).toBe(parsed2.id)
  })

  it('content-identity: different lines yield different ids', () => {
    const parsed1 = logShape.parse!('- 2026-10-22 08:14 — created')
    const parsed2 = logShape.parse!('- 2026-10-22 08:15 — updated')
    expect(parsed1.id).not.toBe(parsed2.id)
  })
})

describe('dateShape', () => {
  it('has correct metadata', () => {
    expect(dateShape.type).toBe('date')
    expect(dateShape.schema).toBe('date.v1.json')
    expect(dateShape.storage).toBe('body')
    expect(dateShape.section).toBe('Dates')
    expect(dateShape.ops).toEqual(['add', 'edit', 'drop'])
    expect(dateShape.lead).toBeUndefined()
  })

  it('round-trips a date with id, on, label, and text', () => {
    const el = { id: 'd4c7', type: 'date', data: { on: '2026-11-02', label: 'deadline', text: 'enviar propuesta' } }
    const rendered = dateShape.render!(el)
    expect(rendered).toBe('- d4c7 · 2026-11-02 · deadline — enviar propuesta')
    const parsed = dateShape.parse!(rendered)
    expect(parsed.id).toBe('d4c7')
    expect(parsed.data.on).toBe('2026-11-02')
    expect(parsed.data.label).toBe('deadline')
    expect(parsed.data.text).toBe('enviar propuesta')
  })

  it('round-trips a date with no label or text', () => {
    const el = { id: 'd4c7', type: 'date', data: { on: '2026-11-02' } }
    const rendered = dateShape.render!(el)
    expect(rendered).toBe('- d4c7 · 2026-11-02')
    const parsed = dateShape.parse!(rendered)
    expect(parsed.id).toBe('d4c7')
    expect(parsed.data.on).toBe('2026-11-02')
    expect(parsed.data.label).toBeUndefined()
    expect(parsed.data.text).toBeUndefined()
  })

  it('round-trips a date with label but no text', () => {
    const el = { id: 'd1e2', type: 'date', data: { on: '2026-10-25', label: 'meeting' } }
    const rendered = dateShape.render!(el)
    expect(rendered).toBe('- d1e2 · 2026-10-25 · meeting')
    const parsed = dateShape.parse!(rendered)
    expect(parsed.id).toBe('d1e2')
    expect(parsed.data.on).toBe('2026-10-25')
    expect(parsed.data.label).toBe('meeting')
    expect(parsed.data.text).toBeUndefined()
  })

  it('round-trips a date with text but no label', () => {
    const el = { id: 'd9x8', type: 'date', data: { on: '2026-12-01', text: 'year-end review' } }
    const rendered = dateShape.render!(el)
    expect(rendered).toBe('- d9x8 · 2026-12-01 — year-end review')
    const parsed = dateShape.parse!(rendered)
    expect(parsed.id).toBe('d9x8')
    expect(parsed.data.on).toBe('2026-12-01')
    expect(parsed.data.label).toBeUndefined()
    expect(parsed.data.text).toBe('year-end review')
  })
})

describe('person', () => {
  it('has correct metadata', () => {
    expect(personShape.type).toBe('person')
    expect(personShape.schema).toBe('person.v1.json')
    expect(personShape.storage).toBe('body')
    expect(personShape.section).toBe('People')
    expect(personShape.ops).toEqual(['add', 'edit', 'drop'])
    expect(personShape.lead).toBeUndefined()
  })

  it('round-trips a person with id, ref, and role', () => {
    const el = { id: 'p9x2', type: 'person', data: { ref: 'ana', role: 'owner' } }
    const rendered = personShape.render!(el)
    expect(rendered).toBe('- p9x2 · ana · owner')
    const parsed = personShape.parse!(rendered)
    expect(parsed.id).toBe('p9x2')
    expect(parsed.data.ref).toBe('ana')
    expect(parsed.data.role).toBe('owner')
  })

  it('round-trips a person with id and ref only (no role)', () => {
    const el = { id: 'p9x2', type: 'person', data: { ref: 'ana' } }
    const rendered = personShape.render!(el)
    expect(rendered).toBe('- p9x2 · ana')
    const parsed = personShape.parse!(rendered)
    expect(parsed.id).toBe('p9x2')
    expect(parsed.data.ref).toBe('ana')
    expect(parsed.data.role).toBeUndefined()
  })
})
