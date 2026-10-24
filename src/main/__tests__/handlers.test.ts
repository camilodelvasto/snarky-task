import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs'
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
  handleUnlabel,
  handleRename,
  handleReslug,
  handleDescribe
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
  it('capture is deterministic: first line is the title, rest is description, no model', async () => {
    const tasksDir = dir()
    const shortname = await handleCreate(
      { tasksDir, now },
      { refs: [], cleaned: 'define our target market\nstart with the DACH region' }
    )
    const card = readCard(join(tasksDir, 'cards', `${shortname}.md`))
    expect(card.title).toBe('define our target market')
    expect(card.description).toBe('start with the DACH region')
  })
  it('capture: #words become labels (or links when a card exists), stripped from the title', async () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'press-plan',
      title: 'press plan',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const shortname = await handleCreate(
      { tasksDir, now },
      {
        refs: ['urgent', 'press-plan'],
        cleaned: 'define our target market #urgent\nsee #press-plan'
      }
    )
    const card = readCard(join(tasksDir, 'cards', `${shortname}.md`))
    expect(card.title).toBe('define our target market')
    expect(card.labels).toEqual(['urgent'])
    expect(card.links).toEqual(['press-plan'])
  })
  it('capture caps an overlong first line at one sanitized line', async () => {
    const tasksDir = dir()
    const long = 'a thought that just keeps going and going '.repeat(4)
    const shortname = await handleCreate({ tasksDir, now }, { refs: [], cleaned: long })
    const card = readCard(join(tasksDir, 'cards', `${shortname}.md`))
    expect(card.title.length).toBeLessThanOrEqual(80)
    expect(card.title).not.toContain('\n')
  })
  it('create with explicit title applies status/tags/due/desc', async () => {
    const tasksDir = dir()
    const shortname = await handleCreate(
      { tasksDir, now },
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
  it('handleNote writes a note (card content), not a system log entry', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'c',
      title: 'c',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: ['2026-10-01 00:00 — created']
    })
    handleNote({ tasksDir, now }, 'c', 'aws_id:abc123')
    const card = readCard(join(tasksDir, 'cards', 'c.md'))
    expect(card.notes.some((n) => n.includes('aws_id:abc123'))).toBe(true)
    expect(card.log.some((l) => l.includes('aws_id'))).toBe(false) // not in the system log
  })
})

describe('handleRename (copy/delete — slug follows the title)', () => {
  it('renames to a new slug, moves artifacts, repoints links, deletes the old', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'interconexion',
      title: 'interconexion',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: ['urgent'],
      description: 'body',
      log: ['2026-10-01 00:00 — created'],
      // Use explicit elements — legacy notes reconcile removed
      elements: [
        { id: 'lead', type: 'text', data: { text: 'body' } },
        { id: 'n1', type: 'note', data: { at: '', text: 'n1' } }
      ]
    } as never)
    writeCard(tasksDir, {
      shortname: 'other',
      title: 'other',
      status: 'active',
      created: '2026-10-01',
      links: ['interconexion'],
      labels: [],
      description: '',
      log: []
    })
    mkdirSync(join(tasksDir, 'artifacts', 'interconexion'), { recursive: true })
    writeFileSync(join(tasksDir, 'artifacts', 'interconexion', 'out.md'), 'output')

    const slug = handleRename({ tasksDir, now }, 'interconexion', 'Evaluacion Puentes RAG')
    expect(slug).toBe('evaluacion-puentes-rag')
    // old gone, new exists with preserved content
    expect(existsSync(join(tasksDir, 'cards', 'interconexion.md'))).toBe(false)
    const nw = readCard(join(tasksDir, 'cards', 'evaluacion-puentes-rag.md'))
    expect(nw.title).toBe('Evaluacion Puentes RAG')
    expect(nw.description).toBe('body')
    expect(nw.notes).toEqual(['n1'])
    expect(nw.labels).toEqual(['urgent'])
    expect(nw.log.some((l) => l.includes('renamed from #interconexion'))).toBe(true)
    // artifacts moved
    expect(existsSync(join(tasksDir, 'artifacts', 'interconexion'))).toBe(false)
    expect(
      readFileSync(join(tasksDir, 'artifacts', 'evaluacion-puentes-rag', 'out.md'), 'utf-8')
    ).toBe('output')
    // link repointed
    expect(readCard(join(tasksDir, 'cards', 'other.md')).links).toEqual(['evaluacion-puentes-rag'])
  })
  it('a same-slug title change is an in-place update (no copy)', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'press-plan',
      title: 'press plan',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const slug = handleRename({ tasksDir, now }, 'press-plan', 'Press Plan')
    expect(slug).toBe('press-plan')
    expect(readCard(join(tasksDir, 'cards', 'press-plan.md')).title).toBe('Press Plan')
  })
})

describe('handleDescribe (set the card body directly)', () => {
  it('replaces the description and keeps title/labels/status; logs the change', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'press-plan',
      title: 'press plan',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: ['urgent'],
      description: 'old body',
      log: []
    })
    handleDescribe({ tasksDir, now }, 'press-plan', 'a fresh body')
    const card = readCard(join(tasksDir, 'cards', 'press-plan.md'))
    expect(card.description).toBe('a fresh body')
    expect(card.title).toBe('press plan')
    expect(card.labels).toEqual(['urgent'])
    expect(card.status).toBe('active')
    expect(card.log.some((l) => l.includes('description'))).toBe(true)
  })
  it('throws for a missing card', () => {
    const tasksDir = dir()
    expect(() => handleDescribe({ tasksDir, now }, 'nope', 'x')).toThrow(/card not found/)
  })
})

describe('handleReslug (change the slug directly — title untouched)', () => {
  it('moves the card to the new slug, keeps the title, moves artifacts, repoints links', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'mostrar-2',
      title: 'Mostrar el panel',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: ['urgent'],
      description: 'body',
      log: ['2026-10-01 00:00 — created'],
      // Use explicit elements — legacy notes reconcile removed
      elements: [
        { id: 'lead', type: 'text', data: { text: 'body' } },
        { id: 'n1', type: 'note', data: { at: '', text: 'n1' } }
      ]
    } as never)
    writeCard(tasksDir, {
      shortname: 'other',
      title: 'other',
      status: 'active',
      created: '2026-10-01',
      links: ['mostrar-2'],
      labels: [],
      description: '',
      log: []
    })
    mkdirSync(join(tasksDir, 'artifacts', 'mostrar-2'), { recursive: true })
    writeFileSync(join(tasksDir, 'artifacts', 'mostrar-2', 'out.md'), 'output')

    const slug = handleReslug({ tasksDir, now }, 'mostrar-2', 'mostrar')
    expect(slug).toBe('mostrar')
    expect(existsSync(join(tasksDir, 'cards', 'mostrar-2.md'))).toBe(false)
    const nw = readCard(join(tasksDir, 'cards', 'mostrar.md'))
    expect(nw.title).toBe('Mostrar el panel') // title preserved, NOT re-derived
    expect(nw.description).toBe('body')
    expect(nw.notes).toEqual(['n1'])
    expect(nw.labels).toEqual(['urgent'])
    expect(nw.log.some((l) => l.includes('reslugged from #mostrar-2'))).toBe(true)
    expect(existsSync(join(tasksDir, 'artifacts', 'mostrar-2'))).toBe(false)
    expect(readFileSync(join(tasksDir, 'artifacts', 'mostrar', 'out.md'), 'utf-8')).toBe('output')
    expect(readCard(join(tasksDir, 'cards', 'other.md')).links).toEqual(['mostrar'])
  })
  it('refuses to clobber an existing slug', () => {
    const tasksDir = dir()
    for (const s of ['mostrar-2', 'mostrar']) {
      writeCard(tasksDir, {
        shortname: s,
        title: s,
        status: 'active',
        created: '2026-10-01',
        links: [],
        labels: [],
        description: '',
        log: []
      })
    }
    expect(() => handleReslug({ tasksDir, now }, 'mostrar-2', 'mostrar')).toThrow(
      /already uses that slug/
    )
    expect(existsSync(join(tasksDir, 'cards', 'mostrar-2.md'))).toBe(true)
  })
  it('rejects an invalid slug', () => {
    const tasksDir = dir()
    writeCard(tasksDir, {
      shortname: 'mostrar-2',
      title: 'm',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    expect(() => handleReslug({ tasksDir, now }, 'mostrar-2', 'bad_slug')).toThrow(
      /not a valid slug/
    )
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
