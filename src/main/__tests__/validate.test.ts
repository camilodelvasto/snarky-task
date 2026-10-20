import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { validateCard, validateInstruction, formatErrors } from '../tasks/validate'

const okCard = {
  v: 1,
  title: 'Press plan',
  status: 'active',
  created: '2026-10-01',
  links: [],
  labels: ['urgent']
}
const okInst = { v: 1, status: 'done', action: 'create', ms: 12 }

describe('validateCard', () => {
  it('accepts a valid card frontmatter', () => {
    expect(validateCard(okCard)).toEqual([])
  })
  it('accepts a legacy card with no v (defaults to 1)', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { v: _v, ...noV } = okCard
    expect(validateCard(noV)).toEqual([])
  })
  it('rejects a bad status enum', () => {
    const errs = validateCard({ ...okCard, status: 'activ' })
    expect(errs.some((e) => e.field === 'status')).toBe(true)
  })
  it('rejects a missing required field', () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { title: _title, ...noTitle } = okCard
    expect(
      validateCard(noTitle).some((e) => e.field === 'title' || e.message.includes('title'))
    ).toBe(true)
  })
  it('rejects an unknown property (typo guard)', () => {
    const errs = validateCard({ ...okCard, tittle: 'x' })
    expect(errs.some((e) => e.field === 'tittle' || e.message.includes('tittle'))).toBe(true)
  })
  it('rejects a bad created pattern', () => {
    expect(
      validateCard({ ...okCard, created: '10/01/2026' }).some((e) => e.field === 'created')
    ).toBe(true)
  })
  it('rejects an unsupported schema version', () => {
    expect(validateCard({ ...okCard, v: 2 })).toEqual([
      { field: 'v', message: 'schema version 2 not supported' }
    ])
  })
})

describe('validateInstruction', () => {
  it('accepts a valid instruction', () => {
    expect(validateInstruction(okInst)).toEqual([])
  })
  it('rejects a bad via enum', () => {
    expect(validateInstruction({ ...okInst, via: 'magic' }).some((e) => e.field === 'via')).toBe(
      true
    )
  })
  it('rejects a non-number ms', () => {
    expect(validateInstruction({ ...okInst, ms: 'fast' }).some((e) => e.field === 'ms')).toBe(true)
  })
})

describe('formatErrors', () => {
  it('joins field: message pairs', () => {
    expect(
      formatErrors([
        { field: 'status', message: 'bad' },
        { field: 'v', message: 'x' }
      ])
    ).toBe('status: bad; v: x')
  })
})

describe('schema ↔ writer drift', () => {
  // Keys writeCard emits into frontmatter (see files.ts writeCard):
  const cardKeys = ['v', 'title', 'status', 'created', 'due', 'links', 'labels']
  // Keys writeInstruction/patchInstruction emit (see files.ts):
  const instrKeys = [
    'v',
    'status',
    'action',
    'card',
    'to',
    'title',
    'desc',
    'tags',
    'due',
    'with',
    'scope',
    'via',
    'engine',
    'model',
    'version',
    'ms',
    'pick',
    'error',
    'result',
    'device'
  ]

  it('every card writer key is a declared card schema property', () => {
    const cardSchema = JSON.parse(
      readFileSync(join(__dirname, '../tasks/schema/card.v1.json'), 'utf-8')
    )
    for (const k of cardKeys) {
      expect(Object.keys(cardSchema.properties)).toContain(k)
    }
  })

  it('every instruction writer key is a declared instruction schema property', () => {
    const instrSchema = JSON.parse(
      readFileSync(join(__dirname, '../tasks/schema/instruction.v1.json'), 'utf-8')
    )
    for (const k of instrKeys) {
      expect(Object.keys(instrSchema.properties)).toContain(k)
    }
  })
})
