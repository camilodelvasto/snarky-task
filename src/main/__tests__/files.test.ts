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
import { mintId } from '../tasks/elements/id'
import { applyOp } from '../tasks/elements/ops'
import { BUNDLED } from '../tasks/elements/registry'

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
    // Use explicit elements (legacy notes reconcile removed); note elements come solely from elements.
    const path = writeCard(dir, {
      shortname: 'keys',
      title: 'keys',
      status: 'active',
      created: '2026-10-19',
      links: [],
      labels: [],
      description: 'desc',
      log: ['2026-10-19 22:16 — created'],
      elements: [
        { id: 'lead', type: 'text', data: { text: 'desc' } },
        { id: 'n1', type: 'note', data: { at: '2026-10-19 22:17', text: 'aws_id:abc123' } }
      ]
    } as never)
    appendLog(path, '2026-10-19 22:20 — status → done')
    const card = readCard(path)
    expect(card.notes).toEqual(['aws_id:abc123'])
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

describe('v:2 stamping, validation, atomic writes', () => {
  it('writeCard stamps v:2, mints an id, and the frontmatter validates', () => {
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
    expect(raw).toMatch(/^v: 2$/m)
    expect(raw).toMatch(/^id: /m)
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

// ─── Task 9: element-based card round-trip ──────────────────────────────────
describe('v:2 element-based card round-trip', () => {
  it('writes a card from elements, reads back with equal elements and correct derived fields', () => {
    const tasksDir = freshTasksDir()
    const taken = new Set<string>()
    const leadId = mintId('t', taken)
    taken.add(leadId)
    const note1Id = mintId('n', taken)
    taken.add(note1Id)
    const note2Id = mintId('n', taken)
    taken.add(note2Id)
    const elements = [
      { id: leadId, type: 'text', data: { text: 'This is the description' } },
      { id: note1Id, type: 'note', data: { at: '2026-10-22 10:00', text: 'first note' } },
      { id: note2Id, type: 'note', data: { at: '2026-10-22 10:01', text: 'second note' } }
    ]
    const path = writeCard(tasksDir, {
      shortname: 'elem-card',
      title: 'Element Card',
      status: 'inbox',
      created: '2026-10-22',
      links: [],
      labels: [],
      description: '',
      log: [],
      elements
    } as never)
    const raw = readFileSync(path, 'utf-8')
    // v:2 frontmatter
    expect(raw).toMatch(/^v: 2$/m)
    // id is present
    expect(raw).toMatch(/^id: /m)
    const card = readCard(path)
    // elements round-trip
    const textEls = card.elements.filter((e) => e.type === 'text')
    const noteEls = card.elements.filter((e) => e.type === 'note')
    expect(textEls).toHaveLength(1)
    expect(noteEls).toHaveLength(2)
    // derived description = lead text element's text
    expect(card.description).toBe('This is the description')
    // derived notes = note elements' data.text
    expect(card.notes).toEqual(['first note', 'second note'])
    // stable id was minted
    expect(typeof card.id).toBe('string')
    expect(card.id.length).toBeGreaterThan(0)
  })

  it('appendLog then readCard: line appears in derived log and log element id equals its content', () => {
    const tasksDir = freshTasksDir()
    const path = writeCard(tasksDir, {
      shortname: 'logcard',
      title: 'Log Card',
      status: 'inbox',
      created: '2026-10-22',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const logLine = '2026-10-22 10:00 — created'
    appendLog(path, logLine)
    const card = readCard(path)
    // line appears in derived log
    expect(card.log).toContain(logLine)
    // log element id equals content (content-identity, used by diffCard dedup)
    const logEls = card.elements.filter((e) => e.type === 'log')
    const matchingLogEl = logEls.find((e) => e.id === logLine)
    expect(matchingLogEl).toBeDefined()
  })

  it('a card with no elements writes a valid empty-body card (just ## Log) and reads back with empty derived fields', () => {
    const tasksDir = freshTasksDir()
    const path = writeCard(tasksDir, {
      shortname: 'empty-elem',
      title: 'Empty Card',
      status: 'inbox',
      created: '2026-10-22',
      links: [],
      labels: [],
      description: '',
      log: [],
      elements: []
    } as never)
    const raw = readFileSync(path, 'utf-8')
    expect(raw).toContain('## Log')
    expect(raw).toMatch(/^v: 2$/m)
    const card = readCard(path)
    expect(card.description).toBe('')
    expect(card.notes).toEqual([])
    expect(card.log).toEqual([])
    expect(card.elements.filter((e) => e.type !== 'output')).toEqual([])
  })

  it('editing the lead text element to "" yields an empty description (empty description is representable)', () => {
    const tasksDir = freshTasksDir()
    // Write a card with a description
    const path = writeCard(tasksDir, {
      shortname: 'desc-card',
      title: 'Desc Card',
      status: 'inbox',
      created: '2026-10-22',
      links: [],
      labels: [],
      description: 'original body',
      log: []
    })
    const existing = readCard(path)
    // applyOp to set lead text to ''
    const updated = applyOp(existing.elements, 'text', 'edit', { text: '' }, BUNDLED)
    writeCard(tasksDir, { ...existing, elements: updated })
    const card = readCard(path)
    // description derived from lead element must be '' (not the original 'original body')
    expect(card.description).toBe('')
  })
})
