import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeInstruction, writeCard } from '../tasks/files'
import { readSnapshot } from '../tasks/snapshot'

it('derives a snapshot from files, skipping unparseable ones', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const d of ['queue', 'cards', 'artifacts']) mkdirSync(join(dir, d), { recursive: true })
  writeInstruction(dir, 'first', new Date('2026-10-02T10:00:00'))
  writeInstruction(dir, 'second', new Date('2026-10-02T11:00:00'))
  writeCard(dir, {
    shortname: 'a-card',
    title: 'A',
    status: 'inbox',
    created: '2026-10-01',
    links: [],
    labels: [],
    description: '',
    log: []
  })
  writeFileSync(join(dir, 'cards', 'broken.md'), '---\ntitle: [unclosed\n')
  const snap = readSnapshot(dir)
  expect(snap.instructions.map((i) => i.raw)).toEqual(['first', 'second'])
  expect(snap.cards.map((c) => c.shortname)).toEqual(['a-card'])
})

it('tolerates a missing subdir (synced workspace drops empty dirs) without throwing', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  mkdirSync(join(dir, 'cards'), { recursive: true }) // only cards/ exists; no queue/ or artifacts/
  expect(() => readSnapshot(dir)).not.toThrow()
  expect(readSnapshot(dir).instructions).toEqual([])
})

it('snapshot includes artifact filenames for a card with files in artifacts/<shortname>/', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const d of ['queue', 'cards', 'artifacts']) mkdirSync(join(dir, d), { recursive: true })
  writeCard(dir, {
    shortname: 'art-card',
    title: 'artifact card',
    status: 'active',
    created: '2026-10-01',
    links: [],
    labels: [],
    description: '',
    log: []
  })
  // Card with no artifacts dir → empty array
  const snap1 = readSnapshot(dir)
  const artCard1 = snap1.cards.find((c) => c.shortname === 'art-card')!
  expect(artCard1.artifacts).toEqual([])

  // Write artifact files into artifacts/art-card/
  const artifactDir = join(dir, 'artifacts', 'art-card')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, '2026-10-02T10-00.md'), 'output one')
  writeFileSync(join(artifactDir, '2026-10-02T11-00.md'), 'output two')

  const snap2 = readSnapshot(dir)
  const artCard2 = snap2.cards.find((c) => c.shortname === 'art-card')!
  expect(artCard2.artifacts).toEqual(['2026-10-02T10-00.md', '2026-10-02T11-00.md'])
})
