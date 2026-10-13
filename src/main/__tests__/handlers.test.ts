import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeCard, readCard } from '../tasks/files'
import {
  handleCreate,
  handleUpdateStatus,
  handleNote,
  handleLink,
  handleDelete,
  handleLabel,
  handleUnlabel
} from '../tasks/handlers'

function dir(): string {
  const d = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const s of ['queue', 'cards', 'artifacts']) mkdirSync(join(d, s), { recursive: true })
  return d
}
const now = new Date('2026-10-02T10:12:00')

describe('handlers', () => {
  it('create writes a card with slug, due, inbox status; raw title without generator', async () => {
    const tasksDir = dir()
    const shortname = await handleCreate(
      { tasksDir, now },
      { refs: [], cleaned: 'write the NGO proposal', due: '2026-10-07' }
    )
    const card = readCard(join(tasksDir, 'cards', `${shortname}.md`))
    expect(card.status).toBe('inbox')
    expect(card.due).toBe('2026-10-07')
    expect(card.title).toBe('write the NGO proposal')
  })
  it('create uses the generator for the title when bound', async () => {
    const tasksDir = dir()
    const generator = { complete: async () => 'Write NGO proposal' }
    const shortname = await handleCreate(
      { tasksDir, now, generator },
      { refs: [], cleaned: 'gotta write the ngo proposal' }
    )
    expect(readCard(join(tasksDir, 'cards', `${shortname}.md`)).title).toBe('Write NGO proposal')
  })
  it('create sanitizes a reasoning-dump title: first usable line, quotes stripped, length-capped', async () => {
    const tasksDir = dir()
    const generator = {
      complete: async () =>
        'We are given a note: "create a new card: start prototype application".\nWe are to extract the underlying task and state it as a short imperative title. Steps: 1. The note says...'
    }
    const shortname = await handleCreate(
      { tasksDir, now, generator },
      { refs: [], cleaned: 'create a new card: start prototype application' }
    )
    const card = readCard(join(tasksDir, 'cards', `${shortname}.md`))
    expect(card.title.length).toBeLessThanOrEqual(80)
    expect(card.title).not.toContain('\n')
  })
  it('create throws when the generator returns nothing usable', async () => {
    const tasksDir = dir()
    const generator = { complete: async () => '  "" \n' }
    await expect(
      handleCreate({ tasksDir, now, generator }, { refs: [], cleaned: 'do a thing' })
    ).rejects.toThrow(/no usable title/)
  })
  it('create with explicit title skips the generator and applies status/tags/due/desc', async () => {
    const tasksDir = dir()
    const generator = {
      complete: async () => {
        throw new Error('generator must not be called')
      }
    }
    const shortname = await handleCreate(
      { tasksDir, now, generator },
      { refs: [], cleaned: 'create ship it $active' },
      {
        title: 'ship it',
        desc: 'the context',
        tags: ['urgent'],
        due: '2026-10-07',
        status: 'active'
      }
    )
    const card = readCard(join(tasksDir, 'cards', `${shortname}.md`))
    expect(card.title).toBe('ship it')
    expect(card.description).toBe('the context')
    expect(card.labels).toEqual(['urgent'])
    expect(card.due).toBe('2026-10-07')
    expect(card.status).toBe('active')
  })
  it('create with explicit title and no desc leaves description empty', async () => {
    const tasksDir = dir()
    const shortname = await handleCreate(
      { tasksDir, now },
      { refs: [], cleaned: 'create ship it' },
      { title: 'ship it' }
    )
    expect(readCard(join(tasksDir, 'cards', `${shortname}.md`)).description).toBe('')
  })
  it('update_status changes frontmatter and appends a log line with the raw text', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'p-y',
      title: 'P Y',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    handleUpdateStatus({ tasksDir, now }, 'p-y', 'dropped', 'proposal for Y got declined')
    const card = readCard(join(tasksDir, 'cards', 'p-y.md'))
    expect(card.status).toBe('dropped')
    expect(card.log[0]).toContain('proposal for Y got declined')
  })
  it('link adds both directions; delete removes the file', () => {
    const tasksDir = dir()
    for (const s of ['a', 'b'])
      writeCard(tasksDir, {
        shortname: s,
        title: s,
        status: 'inbox',
        created: '2026-10-01',
        links: [],
        labels: [],
        description: '',
        log: []
      })
    handleLink({ tasksDir, now }, 'a', 'b')
    expect(readCard(join(tasksDir, 'cards', 'a.md')).links).toContain('b')
    expect(readCard(join(tasksDir, 'cards', 'b.md')).links).toContain('a')
    handleDelete({ tasksDir, now }, 'a')
    expect(existsSync(join(tasksDir, 'cards', 'a.md'))).toBe(false)
  })
  it('targeting a missing card throws', () => {
    expect(() => handleNote({ tasksDir: dir(), now }, 'ghost', 'hello')).toThrow(/card not found/)
  })
})

describe('label handlers', () => {
  it('handleLabel unions tags and logs; handleUnlabel removes and logs', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'p',
      title: 'P',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: ['q4'],
      description: '',
      log: []
    })
    handleLabel({ tasksDir, now }, 'p', ['highlight', 'q4'])
    let card = readCard(join(tasksDir, 'cards', 'p.md'))
    expect(card.labels).toEqual(['q4', 'highlight'])
    expect(card.log.some((l) => l.includes('labels + highlight, q4'))).toBe(true)
    handleUnlabel({ tasksDir, now }, 'p', ['q4'])
    card = readCard(join(tasksDir, 'cards', 'p.md'))
    expect(card.labels).toEqual(['highlight'])
    expect(card.log.some((l) => l.includes('labels − q4'))).toBe(true)
  })
  it('handleLabel surfaces a backlog card: inbox → active with a log line', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'b',
      title: 'B',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    handleLabel({ tasksDir, now }, 'b', ['urgent'])
    const card = readCard(join(tasksDir, 'cards', 'b.md'))
    expect(card.status).toBe('active')
    expect(card.log.some((l) => l.includes('status → active (labeled)'))).toBe(true)
  })
  it('handleLabel leaves non-backlog statuses alone (done stays done)', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'd',
      title: 'D',
      status: 'done',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    handleLabel({ tasksDir, now }, 'd', ['urgent'])
    expect(readCard(join(tasksDir, 'cards', 'd.md')).status).toBe('done')
  })
  it('handleLabel throws instructively without tags (resolver path)', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'p',
      title: 'P',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    expect(() => handleLabel({ tasksDir, now }, 'p', [])).toThrow(/tag #card #tag/)
  })
})
