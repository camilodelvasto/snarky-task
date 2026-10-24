import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import matter from 'gray-matter'
import { readCard, writeCard } from '../tasks/files'

function freshTasksDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const d of ['queue', 'cards', 'artifacts']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

const V1_CARD_CONTENT = `---
v: 1
title: Call the plumber
status: active
created: 2026-10-01
links: []
labels:
  - urgent
---

This is the description of the card.

## Notes
- 2026-10-01 09:00 — first note here
- 2026-10-02 14:30 — second note with details

## Log
- 2026-10-01 09:00 — created
- 2026-10-02 14:30 — status → active
`

describe('v1 → v2 lazy migration via readCard', () => {
  it('reads a v1 card in-memory without rewriting the file', () => {
    const tasksDir = freshTasksDir()
    const cardPath = join(tasksDir, 'cards', 'call-the-plumber.md')
    writeFileSync(cardPath, V1_CARD_CONTENT)

    const card = readCard(cardPath)

    // Derived fields are correct
    expect(card.title).toBe('Call the plumber')
    expect(card.status).toBe('active')
    expect(card.labels).toEqual(['urgent'])
    expect(card.description).toBe('This is the description of the card.')

    // Note elements with correct data
    expect(card.notes).toHaveLength(2)
    expect(card.notes[0]).toBe('first note here')
    expect(card.notes[1]).toBe('second note with details')

    // Log lines
    expect(card.log).toHaveLength(2)
    expect(card.log[0]).toBe('2026-10-01 09:00 — created')
    expect(card.log[1]).toBe('2026-10-02 14:30 — status → active')

    // Elements structure
    const textEls = card.elements.filter((e) => e.type === 'text')
    expect(textEls).toHaveLength(1)
    expect(textEls[0].id).toBe('lead')
    expect(textEls[0].data.text).toBe('This is the description of the card.')

    const noteEls = card.elements.filter((e) => e.type === 'note')
    expect(noteEls).toHaveLength(2)
    expect(noteEls[0].data.text).toBe('first note here')
    expect(noteEls[0].data.at).toBe('2026-10-01 09:00')
    expect(noteEls[1].data.text).toBe('second note with details')
    expect(noteEls[1].data.at).toBe('2026-10-02 14:30')
    // Note ids are fresh minted (not empty string)
    expect(noteEls[0].id).toMatch(/^n/)
    expect(noteEls[1].id).toMatch(/^n/)

    const logEls = card.elements.filter((e) => e.type === 'log')
    expect(logEls).toHaveLength(2)
    // Log element id IS the content line (content-identity)
    expect(logEls[0].id).toBe('2026-10-01 09:00 — created')
    expect(logEls[1].id).toBe('2026-10-02 14:30 — status → active')

    // id is present in the returned card (minted in-memory)
    expect(typeof card.id).toBe('string')
    expect(card.id.length).toBeGreaterThan(0)

    // ON-DISK FILE IS UNCHANGED — still v:1, no id in frontmatter
    const onDisk = readFileSync(cardPath, 'utf-8')
    expect(onDisk).toBe(V1_CARD_CONTENT)
    const { data } = matter(onDisk)
    expect(data.v).toBe(1)
    expect(data.id).toBeUndefined()
  })

  it('note ids are STABLE across reads of the same (unrewritten) v1 card', () => {
    // The file is never rewritten, so every read re-migrates. If note ids were
    // random, a scratch/edit/drop by id from the UI would target an id the next
    // read no longer has. Ids must be content-derived and identical each read.
    const tasksDir = freshTasksDir()
    const cardPath = join(tasksDir, 'cards', 'call-the-plumber.md')
    writeFileSync(cardPath, V1_CARD_CONTENT)

    const idsA = readCard(cardPath).elements.filter((e) => e.type === 'note').map((e) => e.id)
    const idsB = readCard(cardPath).elements.filter((e) => e.type === 'note').map((e) => e.id)
    expect(idsA).toEqual(idsB)
    expect(idsA.every((id) => id.startsWith('n'))).toBe(true)
    expect(new Set(idsA).size).toBe(idsA.length) // distinct
  })

  it('a subsequent writeCard of the returned card produces a v:2 file', () => {
    const tasksDir = freshTasksDir()
    const cardPath = join(tasksDir, 'cards', 'call-the-plumber.md')
    writeFileSync(cardPath, V1_CARD_CONTENT)

    const card = readCard(cardPath)

    // Write the card back (as if an update occurred)
    writeCard(tasksDir, {
      shortname: 'call-the-plumber',
      title: card.title,
      status: card.status,
      created: card.created,
      due: card.due,
      links: card.links,
      labels: card.labels,
      description: card.description,
      notes: card.notes,
      log: card.log,
      elements: card.elements,
      id: card.id
    })

    const onDisk = readFileSync(cardPath, 'utf-8')
    const { data } = matter(onDisk)

    // Must now be v:2 with an id
    expect(data.v).toBe(2)
    expect(typeof data.id).toBe('string')
    expect((data.id as string).length).toBeGreaterThan(0)

    // Content preserved
    const updatedCard = readCard(cardPath)
    expect(updatedCard.description).toBe('This is the description of the card.')
    expect(updatedCard.notes).toHaveLength(2)
    expect(updatedCard.log).toHaveLength(2)
  })

  it('a v1 card with no ## Notes or ## Log still reads correctly', () => {
    const tasksDir = freshTasksDir()
    const cardPath = join(tasksDir, 'cards', 'simple.md')
    const simpleV1 = `---
title: Simple task
status: inbox
created: 2026-10-01
links: []
labels: []
---

Just a description.
`
    writeFileSync(cardPath, simpleV1)

    const card = readCard(cardPath)

    expect(card.title).toBe('Simple task')
    expect(card.description).toBe('Just a description.')

    const textEls = card.elements.filter((e) => e.type === 'text')
    expect(textEls).toHaveLength(1)
    expect(textEls[0].id).toBe('lead')

    expect(card.notes).toEqual([])
    expect(card.log).toEqual([])

    // File unchanged
    const onDisk = readFileSync(cardPath, 'utf-8')
    expect(onDisk).toBe(simpleV1)
  })

  it('a v1 card with blank description produces no text element', () => {
    const tasksDir = freshTasksDir()
    const cardPath = join(tasksDir, 'cards', 'nodesc.md')
    const noDescV1 = `---
v: 1
title: No description
status: inbox
created: 2026-10-01
links: []
labels: []
---

## Notes
- 2026-10-01 10:00 — just a note

## Log
- 2026-10-01 10:00 — created
`
    writeFileSync(cardPath, noDescV1)

    const card = readCard(cardPath)

    expect(card.description).toBe('')
    const textEls = card.elements.filter((e) => e.type === 'text')
    expect(textEls).toHaveLength(0)

    expect(card.notes).toHaveLength(1)
    expect(card.notes[0]).toBe('just a note')
  })
})
