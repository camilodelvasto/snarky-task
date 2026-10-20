import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import matter from 'gray-matter'
import {
  slugify,
  writeInstruction,
  readInstruction,
  patchInstruction,
  writeCard,
  readCard,
  appendLog
} from '../tasks/files'

function freshTasksDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const d of ['queue', 'cards', 'artifacts']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

describe('slugify', () => {
  it('slugs and dedupes', () => {
    expect(slugify('Proposal for Y!', new Set())).toBe('proposal-for-y')
    expect(slugify('Proposal for Y', new Set(['proposal-for-y']))).toBe('proposal-for-y-2')
  })
})

describe('instruction files', () => {
  it('writes queued instruction with verbatim body and reads it back', () => {
    const dir = freshTasksDir()
    const id = writeInstruction(
      dir,
      'gotta write the ngo proposal this wed',
      new Date('2026-10-02T10:12:33Z')
    )
    const inst = readInstruction(join(dir, 'queue', `${id}.md`))
    expect(inst.status).toBe('queued')
    expect(inst.raw).toBe('gotta write the ngo proposal this wed')
    expect(id).toMatch(/^2026-10-02T10-12-33/)
  })
  it('patches frontmatter without touching the body', () => {
    const dir = freshTasksDir()
    const id = writeInstruction(dir, 'raw text stays', new Date())
    const path = join(dir, 'queue', `${id}.md`)
    patchInstruction(path, { status: 'attention', error: 'resolver unavailable' })
    const inst = readInstruction(path)
    expect(inst.status).toBe('attention')
    expect(inst.error).toBe('resolver unavailable')
    expect(inst.raw).toBe('raw text stays')
  })
  it('removes undefined patch values from frontmatter', () => {
    const dir = freshTasksDir()
    const id = writeInstruction(dir, 'test body', new Date())
    const path = join(dir, 'queue', `${id}.md`)
    patchInstruction(path, { status: 'queued', error: 'some error' })
    let inst = readInstruction(path)
    expect(inst.error).toBe('some error')
    patchInstruction(path, { status: 'queued', error: undefined })
    inst = readInstruction(path)
    expect(inst.error).toBeUndefined()
  })
  it('writeInstruction persists extended pre-resolved fields and readInstruction surfaces them', () => {
    const tasksDir = freshTasksDir()
    const id = writeInstruction(
      tasksDir,
      'create ship it #now $active @claude',
      new Date('2026-10-03T10:00:00'),
      {
        action: 'create',
        to: 'active',
        title: 'ship it',
        desc: 'more context',
        tags: ['now'],
        due: '2026-10-03',
        with: 'claude',
        via: 'cli'
      }
    )
    const inst = readInstruction(join(tasksDir, 'queue', `${id}.md`))
    expect(inst.action).toBe('create')
    expect(inst.to).toBe('active')
    expect(inst.title).toBe('ship it')
    expect(inst.desc).toBe('more context')
    expect(inst.tags).toEqual(['now'])
    expect(inst.due).toBe('2026-10-03')
    expect(inst.with).toBe('claude')
    expect(inst.via).toBe('cli')
    expect(inst.raw).toBe('create ship it #now $active @claude')
  })
})

describe('card files', () => {
  it('round-trips a card and appends log lines', () => {
    const dir = freshTasksDir()
    const path = writeCard(dir, {
      shortname: 'proposal-y',
      title: 'Proposal for Y',
      status: 'inbox',
      created: '2026-10-02',
      links: [],
      labels: [],
      description: 'Funding proposal.',
      log: []
    })
    appendLog(path, '2026-10-02 10:12 — declined')
    const card = readCard(path)
    expect(card.title).toBe('Proposal for Y')
    expect(card.log).toEqual(['2026-10-02 10:12 — declined'])
    expect(readFileSync(path, 'utf-8')).toContain('## Log')
  })
  it('keeps notes and the system log in separate sections; appendLog still lands in ## Log', () => {
    const dir = freshTasksDir()
    const path = writeCard(dir, {
      shortname: 'keys',
      title: 'keys',
      status: 'active',
      created: '2026-10-19',
      links: [],
      labels: [],
      description: 'desc',
      notes: ['2026-10-19 22:17 — aws_id:abc123'],
      log: ['2026-10-19 22:16 — created']
    })
    appendLog(path, '2026-10-19 22:20 — status → done')
    const card = readCard(path)
    expect(card.notes).toEqual(['2026-10-19 22:17 — aws_id:abc123'])
    expect(card.log).toEqual(['2026-10-19 22:16 — created', '2026-10-19 22:20 — status → done'])
    const raw = readFileSync(path, 'utf-8')
    expect(raw).toContain('## Notes')
    // the appended log line must be under ## Log, not ## Notes
    expect(raw.indexOf('## Notes')).toBeLessThan(raw.indexOf('## Log'))
  })
  it('a card with no notes omits the ## Notes section', () => {
    const dir = freshTasksDir()
    const path = writeCard(dir, {
      shortname: 'plain',
      title: 'plain',
      status: 'inbox',
      created: '2026-10-19',
      links: [],
      labels: [],
      description: 'x',
      log: []
    })
    expect(readFileSync(path, 'utf-8')).not.toContain('## Notes')
    expect(readCard(path).notes).toEqual([])
  })
})

describe('slugify length', () => {
  it('caps long titles at a word boundary, never mid-word', () => {
    const s = slugify('decide which platform to use for the presentation', new Set())
    expect(s).toBe('decide-which-platform-to-use-for-the')
    expect(s.length).toBeLessThanOrEqual(48)
    expect(s.endsWith('-')).toBe(false)
  })
})

describe('v:1 stamping, validation, atomic writes', () => {
  it('writeCard stamps v:1 and the frontmatter validates', () => {
    const dir = freshTasksDir()
    const path = writeCard(dir, {
      shortname: 'c',
      title: 'C',
      status: 'inbox',
      created: '2026-10-02',
      links: [],
      labels: [],
      description: 'x',
      log: []
    })
    const raw = readFileSync(path, 'utf-8')
    expect(raw).toMatch(/^v: 1$/m)
    expect(() => readCard(path)).not.toThrow()
  })
  it('readCard throws a precise error on a schema-invalid card', () => {
    const dir = freshTasksDir()
    const path = join(dir, 'cards', 'bad.md')
    writeFileSync(
      path,
      matter.stringify('\nbody\n\n## Log\n', {
        title: 'Bad',
        status: 'nope',
        created: '2026-10-02',
        links: [],
        labels: []
      })
    )
    expect(() => readCard(path)).toThrow(/invalid against card\.v1\.json.*status/)
  })
  it('writeCard refuses to persist invalid frontmatter', () => {
    const dir = freshTasksDir()
    // status not in the enum — our own code should never write this
    expect(() =>
      writeCard(dir, {
        shortname: 'c',
        title: 'C',
        status: 'bogus' as never,
        created: '2026-10-02',
        links: [],
        labels: [],
        log: [],
        description: ''
      })
    ).toThrow(/invalid/)
  })
  it('a description containing the literal "## Log" is preserved (line-anchored split)', () => {
    const dir = freshTasksDir()
    const path = writeCard(dir, {
      shortname: 'c',
      title: 'C',
      status: 'inbox',
      created: '2026-10-02',
      links: [],
      labels: [],
      description: 'see the section ## Log inline here',
      log: ['2026-10-02 10:00 — created']
    })
    const card = readCard(path)
    expect(card.description).toContain('## Log inline here')
    expect(card.log).toEqual(['2026-10-02 10:00 — created'])
  })
  it('writeInstruction stamps v:1 and reads back valid', () => {
    const dir = freshTasksDir()
    const id = writeInstruction(dir, 'hello', new Date('2026-10-02T10:00:00'))
    const raw = readFileSync(join(dir, 'queue', `${id}.md`), 'utf-8')
    expect(raw).toMatch(/^v: 1$/m)
    expect(readInstruction(join(dir, 'queue', `${id}.md`)).status).toBe('queued')
  })
  it('writeFileAtomic leaves no temp files behind', () => {
    const dir = freshTasksDir()
    writeCard(dir, {
      shortname: 'c',
      title: 'C',
      status: 'inbox',
      created: '2026-10-02',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    expect(
      readdirSync(join(dir, 'cards')).every((f) => !f.startsWith('.') || f === '.gitkeep')
    ).toBe(true)
  })
})

describe('writeInstruction on a missing queue dir (synced workspace)', () => {
  it('creates the parent dir rather than ENOENT', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
    // deliberately do NOT create queue/ — simulate a Syncthing-dropped empty dir
    expect(() => writeInstruction(dir, 'hello', new Date('2026-10-02T10:00:00'))).not.toThrow()
    expect(readdirSync(join(dir, 'queue')).some((f) => f.endsWith('.md'))).toBe(true)
  })
})
