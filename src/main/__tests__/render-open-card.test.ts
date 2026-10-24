import { it, expect } from 'vitest'
import { renderOpenCard } from '../../../surfaces/board/cards.js'

const elementTypes = {
  text: { lead: true, ops: ['edit'] },
  note: { section: 'Notes', ops: ['add', 'edit', 'scratch', 'drop'] },
  log: { section: 'Log', system: true, ops: ['append'] },
  output: { ops: ['add', 'edit', 'drop'] }
}

function cardWith(elements: unknown[], extra: Record<string, unknown> = {}) {
  return {
    shortname: 'c',
    title: 'T',
    status: 'active',
    created: '2026-10-01',
    links: [],
    labels: [],
    description: '',
    notes: [],
    log: [],
    artifacts: [],
    elements,
    ...extra
  }
}

it('renders notes from note elements with ids + scratched state, no ## Notes literal', () => {
  const html: string = renderOpenCard(
    cardWith(
      [
        { id: 'lead', type: 'text', data: { text: 'the body' } },
        { id: 'n1', type: 'note', data: { at: '08:53', text: 'first thought' } },
        { id: 'n2', type: 'note', data: { at: '07:20', text: 'scratched one', scratched: true } },
        { id: 'l1', type: 'log', data: { line: '2026-10-22 08:14 — created' } },
        { id: 'l2', type: 'log', data: { line: '2026-10-22 08:15 — edited' } }
      ],
      { description: 'the body' }
    ),
    { elementTypes }
  )
  expect(html).toContain('first thought')
  expect(html).toContain('scratched one')
  expect(html).toMatch(/data-el-id="n1"/)
  expect(html).toMatch(/data-el-type="note"/)
  expect(html).toMatch(/scratched/) // the scratched note carries a scratched marker
  expect(html).toMatch(/data-sec="notes"/) // notes is a unified collapsible section
  expect(html).toMatch(/data-sec="activity"/) // the log is the activity section now
  expect(html).toContain('· 2') // the activity count
  expect(html).not.toContain('## Notes')
})

it('an empty card renders no note items and does not throw', () => {
  let html = ''
  expect(() => {
    html = renderOpenCard(cardWith([{ id: 'lead', type: 'text', data: { text: '' } }]), {
      elementTypes
    })
  }).not.toThrow()
  expect(html).not.toContain('data-el-type="note"')
})

it('skips an element whose type is unknown to the type map, without crashing', () => {
  expect(() =>
    renderOpenCard(
      cardWith([
        { id: 'lead', type: 'text', data: { text: 'x' } },
        { id: 'z1', type: 'mystery', data: { whatever: 1 } }
      ]),
      { elementTypes }
    )
  ).not.toThrow()
})

it('renders an output as a datetime-led line with a preview, collapsed by default', () => {
  const html: string = renderOpenCard(
    cardWith(
      [
        { id: 'lead', type: 'text', data: { text: '' } },
        {
          id: 'o1',
          type: 'output',
          data: { file: '2026-10-23T13-28.md', ts: '2026-10-23 13:28', preview: 'hi dana' }
        }
      ],
      { artifacts: ['2026-10-23T13-28.md'] }
    ),
    { elementTypes }
  )
  expect(html).toMatch(/data-sec="output"/)
  expect(html).toContain('2026-10-23 13:28') // timestamp is the title
  expect(html).toContain('hi dana') // inline preview
  expect(html).toMatch(/data-act="toggle-out"/) // the whole row toggles
  expect(html).toMatch(/data-collapsed="true"/) // collapsed by default
})

it('activity log lines render time · text, normalizing the stored separator', () => {
  const html: string = renderOpenCard(
    cardWith([
      { id: 'lead', type: 'text', data: { text: '' } },
      { id: 'l1', type: 'log', data: { line: '2026-10-22 08:14 — created' } }
    ]),
    { elementTypes }
  )
  expect(html).toContain('2026-10-22 08:14')
  expect(html).toContain('created')
  expect(html).not.toContain('08:14 —') // em-dash normalized to the centered dot
})

it('shows an undo line in activity when a pendingUndo targets this card', () => {
  const html: string = renderOpenCard(
    cardWith([
      { id: 'lead', type: 'text', data: { text: '' } },
      { id: 'l1', type: 'log', data: { line: '2026-10-22 08:14 — note drop' } }
    ]),
    { elementTypes, pendingUndo: { shortname: 'c', label: 'note' } }
  )
  expect(html).toContain('note dropped')
  expect(html).toMatch(/data-act="undo"/)
})
