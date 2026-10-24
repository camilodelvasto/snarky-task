import { describe, it, expect } from 'vitest'
import { BUNDLED } from '../tasks/elements/registry'
import { bodyToElements, elementsToBody } from '../tasks/elements/serialize'

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Build the canonical `decisiones` body using the shapes' own render methods
 * so separators exactly match what the serializer will produce.
 */
function decisonesBody(): string {
  const note = BUNDLED.note
  const date = BUNDLED.date
  const person = BUNDLED.person
  const log = BUNDLED.log

  const leadText = 'Decide on the office paint color before Friday.'

  const noteEl1 = { id: 'n1a2', type: 'note', data: { at: '2026-10-20T09:00:00Z', text: 'Leaning toward sage green' } }
  const noteEl2 = { id: 'n3b4', type: 'note', data: { at: '2026-10-20T10:00:00Z', text: 'Ana prefers white — classic choice' } }

  const dateEl = { id: 'd9c7', type: 'date', data: { on: '2026-10-25', label: 'deadline', text: 'final decision' } }

  const personEl = { id: 'p5e6', type: 'person', data: { ref: 'ana', role: 'owner' } }

  const logEl1 = { id: '2026-10-20 09:00 — created', type: 'log', data: { line: '2026-10-20 09:00 — created' } }
  const logEl2 = { id: '2026-10-20 10:00 — updated', type: 'log', data: { line: '2026-10-20 10:00 — updated' } }

  return [
    leadText,
    '',
    '## Notes',
    note.render!(noteEl1),
    note.render!(noteEl2),
    '',
    '## Dates',
    date.render!(dateEl),
    '',
    '## People',
    person.render!(personEl),
    '',
    '## Log',
    log.render!(logEl1),
    log.render!(logEl2),
  ].join('\n')
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('bodyToElements', () => {
  it('parses the full decisiones body into typed elements', () => {
    const body = decisonesBody()
    const elements = bodyToElements(body, BUNDLED)

    // lead
    expect(elements[0]).toMatchObject({ type: 'text', data: { text: 'Decide on the office paint color before Friday.' } })

    // notes
    const notes = elements.filter(e => e.type === 'note')
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatchObject({ id: 'n1a2', type: 'note', data: { at: '2026-10-20T09:00:00Z', text: 'Leaning toward sage green' } })
    expect(notes[1]).toMatchObject({ id: 'n3b4', type: 'note', data: { at: '2026-10-20T10:00:00Z', text: 'Ana prefers white — classic choice' } })

    // dates
    const dates = elements.filter(e => e.type === 'date')
    expect(dates).toHaveLength(1)
    expect(dates[0]).toMatchObject({ id: 'd9c7', type: 'date', data: { on: '2026-10-25', label: 'deadline', text: 'final decision' } })

    // people
    const people = elements.filter(e => e.type === 'person')
    expect(people).toHaveLength(1)
    expect(people[0]).toMatchObject({ id: 'p5e6', type: 'person', data: { ref: 'ana', role: 'owner' } })

    // log
    const logs = elements.filter(e => e.type === 'log')
    expect(logs).toHaveLength(2)
    expect(logs[0].data.line).toBe('2026-10-20 09:00 — created')
    expect(logs[1].data.line).toBe('2026-10-20 10:00 — updated')
  })

  it('skips fs shapes (output) — never included', () => {
    const elements = bodyToElements(decisonesBody(), BUNDLED)
    expect(elements.every(e => e.type !== 'output')).toBe(true)
  })

  it('omits the lead element when the pre-header block is blank', () => {
    const body = '## Log\n- 2026-10-20 09:00 — created'
    const elements = bodyToElements(body, BUNDLED)
    expect(elements.find(e => e.type === 'text')).toBeUndefined()
  })

  it('omits the lead element for an empty string body', () => {
    const elements = bodyToElements('', BUNDLED)
    expect(elements.find(e => e.type === 'text')).toBeUndefined()
  })

  it('throws on an unknown ## section header', () => {
    const body = '## Whatever\n- some bullet'
    expect(() => bodyToElements(body, BUNDLED)).toThrow()
  })

  it('hand-typed id-less note gets a minted non-empty id', () => {
    const body = '## Notes\n- just a thought'
    const elements = bodyToElements(body, BUNDLED)
    const note = elements.find(e => e.type === 'note')!
    expect(note).toBeDefined()
    expect(note.id).toBeTruthy()
    expect(note.id.length).toBeGreaterThan(0)
    // id starts with 'n' (first char of 'note')
    expect(note.id[0]).toBe('n')
  })

  it('id-less note keeps at empty — serializer does NOT stamp timestamp', () => {
    const body = '## Notes\n- just a thought'
    const elements = bodyToElements(body, BUNDLED)
    const note = elements.find(e => e.type === 'note')!
    expect(note.data.at).toBe('')
  })
})

describe('elementsToBody', () => {
  it('round-trips the full decisiones body to an equal string', () => {
    const body = decisonesBody()
    const elements = bodyToElements(body, BUNDLED)
    const rebuilt = elementsToBody(elements, BUNDLED)
    expect(rebuilt).toBe(body)
  })

  it('empty elements list produces only the ## Log header (no empty lead)', () => {
    const result = elementsToBody([], BUNDLED)
    expect(result).toBe('## Log')
    expect(result).not.toContain('## Notes')
    expect(result).not.toContain('## Dates')
    expect(result).not.toContain('## People')
  })

  it('lead-only card produces lead + ## Log, no other sections', () => {
    const elements = [{ id: 'lead', type: 'text', data: { text: 'just a title' } }]
    const result = elementsToBody(elements, BUNDLED)
    expect(result).toBe('just a title\n\n## Log')
    expect(result).not.toContain('## Notes')
  })

  it('always emits ## Log last even when log elements are present', () => {
    const elements = [
      { id: 'lead', type: 'text', data: { text: 'something' } },
      { id: 'n1a2', type: 'note', data: { at: '2026-10-20T09:00:00Z', text: 'a note' } },
      { id: '2026-10-20 09:00 — created', type: 'log', data: { line: '2026-10-20 09:00 — created' } },
    ]
    const result = elementsToBody(elements, BUNDLED)
    const logIdx = result.lastIndexOf('## Log')
    const notesIdx = result.indexOf('## Notes')
    expect(logIdx).toBeGreaterThan(notesIdx)
  })

  it('fs (output) elements are silently skipped', () => {
    const elements = [
      { id: 'lead', type: 'text', data: { text: 'a plain title' } },
      { id: 'o1234567', type: 'output', data: { file: 'result.md' } },
    ]
    const result = elementsToBody(elements, BUNDLED)
    // result.md should not appear — the fs output element is skipped
    expect(result).not.toContain('result.md')
    // The type name 'output' should not appear as a section header
    expect(result).not.toContain('## Output')
    expect(result).not.toContain('## output')
    expect(result).toContain('a plain title')
  })
})

describe('round-trip stability', () => {
  it('id-less note: minted id is stable across a second round-trip', () => {
    const body = '## Notes\n- just a thought'
    const elements = bodyToElements(body, BUNDLED)
    const rebuilt = elementsToBody(elements, BUNDLED)
    // The rebuilt body now has the minted id in the note line
    const elements2 = bodyToElements(rebuilt, BUNDLED)
    const note1 = elements.find(e => e.type === 'note')!
    const note2 = elements2.find(e => e.type === 'note')!
    expect(note2.id).toBe(note1.id)
  })

  it('idempotent: bodyToElements → elementsToBody → bodyToElements yields same elements', () => {
    const body = decisonesBody()
    const elements1 = bodyToElements(body, BUNDLED)
    const rebuilt = elementsToBody(elements1, BUNDLED)
    const elements2 = bodyToElements(rebuilt, BUNDLED)
    expect(elements2).toEqual(elements1)
  })
})
