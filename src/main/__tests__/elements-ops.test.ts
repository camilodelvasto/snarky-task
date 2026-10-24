import { describe, it, expect } from 'vitest'
import type { Element } from '../tasks/elements/types'
import { applyOp } from '../tasks/elements/ops'
import { BUNDLED } from '../tasks/elements/registry'

// Helpers
function noteEl(id: string, at: string, text: string, scratched?: boolean): Element {
  const data: Record<string, unknown> = { at, text }
  if (scratched) data.scratched = true
  return { id, type: 'note', data }
}

function textEl(text: string): Element {
  return { id: 'lead', type: 'text', data: { text } }
}

describe('applyOp — purity', () => {
  it('does not mutate the input array', () => {
    const els: Element[] = [textEl('hello')]
    const frozen = [...els]
    applyOp(els, 'text', 'edit', { text: 'world' }, BUNDLED)
    expect(els).toEqual(frozen)
  })
})

describe('applyOp — note.add', () => {
  it('appends a new note element with fresh id and correct at/text', () => {
    const els: Element[] = []
    const result = applyOp(els, 'note', 'add', { at: '2026-10-02 10:12', text: 'hello' }, BUNDLED)
    expect(result).toHaveLength(1)
    const n = result[0]
    expect(n.type).toBe('note')
    expect(n.data.text).toBe('hello')
    expect(n.data.at).toBe('2026-10-02 10:12')
    expect(typeof n.id).toBe('string')
    expect(n.id.startsWith('n')).toBe(true)
  })

  it('generates unique ids across multiple adds', () => {
    let els: Element[] = []
    for (let i = 0; i < 5; i++) {
      els = applyOp(els, 'note', 'add', { at: '2026-10-02 10:12', text: `note ${i}` }, BUNDLED)
    }
    const ids = els.map((e) => e.id)
    expect(new Set(ids).size).toBe(5)
  })

  it('appends at the end of existing notes', () => {
    const existing = noteEl('n0001', '2026-10-01 09:00', 'first')
    const result = applyOp([existing], 'note', 'add', { at: '2026-10-02 10:12', text: 'second' }, BUNDLED)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(existing)
    expect(result[1].data.text).toBe('second')
  })
})

describe('applyOp — note.edit', () => {
  it('replaces data.text of the element with the given id', () => {
    const els = [noteEl('n0001', '2026-10-01 09:00', 'original')]
    const result = applyOp(els, 'note', 'edit', { id: 'n0001', text: 'updated' }, BUNDLED)
    expect(result).toHaveLength(1)
    expect(result[0].data.text).toBe('updated')
    expect(result[0].data.at).toBe('2026-10-01 09:00') // at unchanged
    expect(result[0].id).toBe('n0001')
  })

  it('throws if the id does not exist', () => {
    const els = [noteEl('n0001', '2026-10-01 09:00', 'text')]
    expect(() => applyOp(els, 'note', 'edit', { id: 'n9999', text: 'x' }, BUNDLED)).toThrow(
      /not found/
    )
  })
})

describe('applyOp — note.scratch', () => {
  it('sets scratched=true on an unscratched note', () => {
    const els = [noteEl('n0001', '2026-10-01 09:00', 'a note')]
    const result = applyOp(els, 'note', 'scratch', { id: 'n0001' }, BUNDLED)
    expect(result[0].data.scratched).toBe(true)
  })

  it('toggles scratched back to false (removes the key)', () => {
    const els = [noteEl('n0001', '2026-10-01 09:00', 'a note', true)]
    const result = applyOp(els, 'note', 'scratch', { id: 'n0001' }, BUNDLED)
    expect(result[0].data.scratched).toBeFalsy()
  })

  it('throws if the id does not exist', () => {
    expect(() =>
      applyOp([], 'note', 'scratch', { id: 'n0001' }, BUNDLED)
    ).toThrow(/not found/)
  })
})

describe('applyOp — drop ops', () => {
  it('note.drop removes the element by id', () => {
    const els = [noteEl('n0001', '2026-10-01 09:00', 'a'), noteEl('n0002', '2026-10-01 09:01', 'b')]
    const result = applyOp(els, 'note', 'drop', { id: 'n0001' }, BUNDLED)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('n0002')
  })

  it('date.drop removes a date element by id', () => {
    const dateEl: Element = { id: 'd0001', type: 'date', data: { on: '2026-10-10', label: 'deadline' } }
    const result = applyOp([dateEl], 'date', 'drop', { id: 'd0001' }, BUNDLED)
    expect(result).toHaveLength(0)
  })

  it('person.drop removes a person element by id', () => {
    const personEl: Element = { id: 'p0001', type: 'person', data: { ref: 'alice' } }
    const result = applyOp([personEl], 'person', 'drop', { id: 'p0001' }, BUNDLED)
    expect(result).toHaveLength(0)
  })

  it('drop throws if the id does not exist', () => {
    expect(() =>
      applyOp([], 'note', 'drop', { id: 'n9999' }, BUNDLED)
    ).toThrow(/not found/)
  })
})

describe('applyOp — text.edit', () => {
  it('replaces the lead text element data.text', () => {
    const els = [textEl('old body')]
    const result = applyOp(els, 'text', 'edit', { text: 'new body' }, BUNDLED)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('text')
    expect(result[0].data.text).toBe('new body')
    expect(result[0].id).toBe('lead')
  })

  it('creates a lead text element with id "lead" if none exists', () => {
    const els: Element[] = []
    const result = applyOp(els, 'text', 'edit', { text: 'brand new' }, BUNDLED)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('lead')
    expect(result[0].type).toBe('text')
    expect(result[0].data.text).toBe('brand new')
  })

  it('preserves other elements when updating the lead', () => {
    const note = noteEl('n0001', '2026-10-01 09:00', 'a note')
    const els = [textEl('old'), note]
    const result = applyOp(els, 'text', 'edit', { text: 'new' }, BUNDLED)
    expect(result).toHaveLength(2)
    expect(result.find((e) => e.type === 'note')).toEqual(note)
  })
})

describe('applyOp — guards', () => {
  it('throws for an op not declared in the shape', () => {
    expect(() =>
      applyOp([], 'text', 'add', { text: 'x' }, BUNDLED)
    ).toThrow(/not declared|unknown op/i)
  })

  it('throws for an undeclared op on note type', () => {
    expect(() =>
      applyOp([], 'note', 'frobnicate', { text: 'x' }, BUNDLED)
    ).toThrow(/not declared|unknown op/i)
  })

  it('throws for an unknown element type', () => {
    expect(() =>
      applyOp([], 'bogus', 'add', {}, BUNDLED)
    ).toThrow(/unknown element type/i)
  })
})

describe('applyOp — drop purity', () => {
  it('does not mutate the input array after note.drop', () => {
    const els: Element[] = [
      noteEl('n0001', '2026-10-01 09:00', 'first'),
      noteEl('n0002', '2026-10-01 09:01', 'second'),
    ]
    const frozen = [...els]
    applyOp(els, 'note', 'drop', { id: 'n0001' }, BUNDLED)
    expect(els).toEqual(frozen)
    expect(els).toHaveLength(2)
  })
})
