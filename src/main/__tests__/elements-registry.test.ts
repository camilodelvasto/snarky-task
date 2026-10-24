// src/main/__tests__/elements-registry.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BUNDLED, loadElements, reconcileElements } from '../tasks/elements/registry'

const TEMPLATE_ELEMENTS = JSON.stringify(
  {
    text: { schema: 'text.v1.json', lead: true, ops: ['edit'] },
    note: { schema: 'note.v1.json', section: 'Notes', ops: ['add', 'edit', 'scratch', 'drop'] },
    date: { schema: 'date.v1.json', section: 'Dates', ops: ['add', 'edit', 'drop'] },
    person: { schema: 'person.v1.json', section: 'People', ops: ['add', 'edit', 'drop'] },
    output: { schema: 'output.v1.json', storage: 'fs', ops: ['add', 'edit', 'drop'] },
    log: { schema: 'log.v1.json', section: 'Log', system: true, ops: ['append'] }
  },
  null,
  2
)

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'elem-reg-'))
}

describe('BUNDLED', () => {
  it('contains all six types', () => {
    expect(Object.keys(BUNDLED).sort()).toEqual(
      ['date', 'log', 'note', 'output', 'person', 'text'].sort()
    )
  })
})

describe('loadElements', () => {
  it('returns shapes for all six types when elements.json has the template content', () => {
    const dir = makeTmpDir()
    writeFileSync(join(dir, 'elements.json'), TEMPLATE_ELEMENTS)
    const { types, shapes } = loadElements(dir)
    expect(Object.keys(types).sort()).toEqual(
      ['date', 'log', 'note', 'output', 'person', 'text'].sort()
    )
    expect(Object.keys(shapes).sort()).toEqual(
      ['date', 'log', 'note', 'output', 'person', 'text'].sort()
    )
    // shapes are the actual shape objects from BUNDLED
    expect(shapes.text).toBe(BUNDLED.text)
    expect(shapes.log).toBe(BUNDLED.log)
  })

  it('throws when elements.json contains an unknown type key', () => {
    const dir = makeTmpDir()
    const bad = JSON.stringify({
      text: { schema: 'text.v1.json', lead: true, ops: ['edit'] },
      unknown_type: { schema: 'unknown.v1.json', ops: [] }
    })
    writeFileSync(join(dir, 'elements.json'), bad)
    expect(() => loadElements(dir)).toThrow(/unknown_type/)
  })

  it('throws when elements.json does not exist', () => {
    const dir = makeTmpDir()
    expect(() => loadElements(dir)).toThrow()
  })
})

describe('reconcileElements', () => {
  it('backfills a missing type key (date) and returns ["date"]', () => {
    const dir = makeTmpDir()
    const templatePath = join(makeTmpDir(), 'elements.json')
    writeFileSync(templatePath, TEMPLATE_ELEMENTS)
    // Project elements.json is missing `date`
    const partial = {
      text: { schema: 'text.v1.json', lead: true, ops: ['edit'] },
      note: { schema: 'note.v1.json', section: 'Notes', ops: ['add', 'edit', 'scratch', 'drop'] },
      person: { schema: 'person.v1.json', section: 'People', ops: ['add', 'edit', 'drop'] },
      output: { schema: 'output.v1.json', storage: 'fs', ops: ['add', 'edit', 'drop'] },
      log: { schema: 'log.v1.json', section: 'Log', system: true, ops: ['append'] }
    }
    writeFileSync(join(dir, 'elements.json'), JSON.stringify(partial, null, 2))
    const added = reconcileElements(dir, templatePath)
    expect(added).toEqual(['date'])
    // Verify date was written back
    const written = JSON.parse(readFileSync(join(dir, 'elements.json'), 'utf-8'))
    expect(written.date).toEqual({ schema: 'date.v1.json', section: 'Dates', ops: ['add', 'edit', 'drop'] })
  })

  it('returns [] when elements.json is already complete (no-op)', () => {
    const dir = makeTmpDir()
    const templatePath = join(makeTmpDir(), 'elements.json')
    writeFileSync(templatePath, TEMPLATE_ELEMENTS)
    writeFileSync(join(dir, 'elements.json'), TEMPLATE_ELEMENTS)
    const added = reconcileElements(dir, templatePath)
    expect(added).toEqual([])
  })

  it('returns [] when the template file is missing', () => {
    const dir = makeTmpDir()
    const missingTemplate = join(makeTmpDir(), 'nonexistent.json')
    writeFileSync(join(dir, 'elements.json'), TEMPLATE_ELEMENTS)
    const added = reconcileElements(dir, missingTemplate)
    expect(added).toEqual([])
  })

  it('returns [] when the project elements.json does not exist', () => {
    const dir = makeTmpDir()
    const templatePath = join(makeTmpDir(), 'elements.json')
    writeFileSync(templatePath, TEMPLATE_ELEMENTS)
    // No elements.json in dir
    const added = reconcileElements(dir, templatePath)
    expect(added).toEqual([])
  })
})
