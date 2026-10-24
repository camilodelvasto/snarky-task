import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { outputShape } from '../tasks/elements/output'

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'td-output-'))
}

describe('outputShape', () => {
  it('has correct metadata', () => {
    expect(outputShape.type).toBe('output')
    expect(outputShape.schema).toBe('output.v1.json')
    expect(outputShape.storage).toBe('fs')
    expect(outputShape.ops).toEqual(['add', 'edit', 'drop'])
    expect(outputShape.ops).not.toContain('scratch')
  })

  it('has no parse or render', () => {
    expect(outputShape.parse).toBeUndefined()
    expect(outputShape.render).toBeUndefined()
  })

  it('materialize returns empty array when artifacts/<shortname>/ dir does not exist', () => {
    const tasksDir = makeTempDir()
    mkdirSync(join(tasksDir, 'artifacts'), { recursive: true })
    const result = outputShape.materialize!(tasksDir, 'missing-card')
    expect(result).toEqual([])
  })

  it('materialize returns empty array when artifacts/ dir itself does not exist', () => {
    const tasksDir = makeTempDir()
    const result = outputShape.materialize!(tasksDir, 'missing-card')
    expect(result).toEqual([])
  })

  it('materialize returns one element per file with correct data.file', () => {
    const tasksDir = makeTempDir()
    const artifactDir = join(tasksDir, 'artifacts', 'foo')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'report.md'), 'content a')
    writeFileSync(join(artifactDir, 'summary.txt'), 'content b')

    const result = outputShape.materialize!(tasksDir, 'foo')
    expect(result).toHaveLength(2)

    const files = result.map(el => el.data.file as string).sort()
    expect(files).toEqual(['report.md', 'summary.txt'])
  })

  it('materialize assigns type=output to all elements', () => {
    const tasksDir = makeTempDir()
    const artifactDir = join(tasksDir, 'artifacts', 'foo')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'out.json'), '{}')

    const result = outputShape.materialize!(tasksDir, 'foo')
    expect(result[0].type).toBe('output')
  })

  it('materialize ids are stable across two calls', () => {
    const tasksDir = makeTempDir()
    const artifactDir = join(tasksDir, 'artifacts', 'bar')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'alpha.md'), 'x')
    writeFileSync(join(artifactDir, 'beta.txt'), 'y')

    const first = outputShape.materialize!(tasksDir, 'bar')
    const second = outputShape.materialize!(tasksDir, 'bar')

    const firstById = Object.fromEntries(first.map(el => [el.data.file, el.id]))
    const secondById = Object.fromEntries(second.map(el => [el.data.file, el.id]))

    expect(firstById['alpha.md']).toBe(secondById['alpha.md'])
    expect(firstById['beta.txt']).toBe(secondById['beta.txt'])
  })

  it('materialize ids are distinct for different filenames', () => {
    const tasksDir = makeTempDir()
    const artifactDir = join(tasksDir, 'artifacts', 'baz')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'file1.md'), '')
    writeFileSync(join(artifactDir, 'file2.md'), '')

    const result = outputShape.materialize!(tasksDir, 'baz')
    const ids = result.map(el => el.id)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('materialize derives a readable ts from a timestamp filename', () => {
    const tasksDir = makeTempDir()
    const artifactDir = join(tasksDir, 'artifacts', 'ts')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, '2026-10-23T13-28-15.md'), 'hello')
    writeFileSync(join(artifactDir, '2026-10-22T16-40.md'), 'world') // minute-stamped (delegated)

    const byFile = Object.fromEntries(
      outputShape.materialize!(tasksDir, 'ts').map((e) => [e.data.file, e.data.ts])
    )
    expect(byFile['2026-10-23T13-28-15.md']).toBe('2026-10-23 13:28')
    expect(byFile['2026-10-22T16-40.md']).toBe('2026-10-22 16:40')
  })

  it('materialize falls back to the filename (minus .md) when it is not a timestamp', () => {
    const tasksDir = makeTempDir()
    const artifactDir = join(tasksDir, 'artifacts', 'named')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'reply-draft.md'), 'x')
    const el = outputShape.materialize!(tasksDir, 'named')[0]
    expect(el.data.ts).toBe('reply-draft')
  })

  it('materialize preview is the first wordy line, markdown marker stripped', () => {
    const tasksDir = makeTempDir()
    const artifactDir = join(tasksDir, 'artifacts', 'prev')
    mkdirSync(artifactDir, { recursive: true })
    writeFileSync(join(artifactDir, 'a.md'), '\n\n# Parts list\n\n- cartridge\n- o-ring')
    writeFileSync(join(artifactDir, 'b.md'), 'Hi Dana,\n\nthanks for the quote.')
    writeFileSync(join(artifactDir, 'c.md'), '') // empty → empty preview, still a string

    const byFile = Object.fromEntries(
      outputShape.materialize!(tasksDir, 'prev').map((e) => [e.data.file, e.data.preview])
    )
    expect(byFile['a.md']).toBe('Parts list')
    expect(byFile['b.md']).toBe('Hi Dana,')
    expect(byFile['c.md']).toBe('')
  })

  it('a subdirectory under artifacts/<shortname>/ is NOT materialized as an output element', () => {
    const tasksDir = makeTempDir()
    const artifactDir = join(tasksDir, 'artifacts', 'qux')
    mkdirSync(artifactDir, { recursive: true })
    // a file — should be included
    writeFileSync(join(artifactDir, 'result.md'), 'content')
    // a subdirectory — must NOT be included
    mkdirSync(join(artifactDir, 'subdir'), { recursive: true })
    writeFileSync(join(artifactDir, 'subdir', 'nested.md'), 'nested')

    const result = outputShape.materialize!(tasksDir, 'qux')
    // only the file at the top level; the subdir itself must not appear
    expect(result).toHaveLength(1)
    expect(result[0].data.file).toBe('result.md')
  })
})
