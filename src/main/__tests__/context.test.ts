import { describe, it, expect } from 'vitest'
import { buildDelegationContext } from '../tasks/context'
import type { Card } from '../tasks/types'

function card(over: Partial<Card> = {}): Card {
  return {
    shortname: 'draft-reply',
    id: 'draft-reply',
    path: '/x/cards/draft-reply.md',
    title: 'Draft the reply',
    status: 'active',
    created: '2026-10-19',
    links: [],
    labels: [],
    elements: [],
    description: 'Answer the vendor about pricing.',
    notes: [],
    log: ['2026-10-19 10:00 — created'],
    artifacts: [],
    ...over
  }
}

describe('buildDelegationContext', () => {
  it('card scope sends only title, description, and instruction text', () => {
    const out = buildDelegationContext({ card: card(), scope: 'card', text: 'make it polite' })
    expect(out).toBe('Draft the reply\n\nAnswer the vendor about pricing.\n\nmake it polite')
  })

  it('card scope omits activity and prior outputs even when present', () => {
    const out = buildDelegationContext({
      card: card({ log: ['a', 'b'] }),
      scope: 'card',
      artifactTexts: ['old draft']
    })
    expect(out).not.toContain('Activity')
    expect(out).not.toContain('old draft')
  })

  it('full scope adds the activity log and prior outputs', () => {
    const out = buildDelegationContext({
      card: card({ log: ['2026-10-19 10:00 — created', '2026-10-19 11:00 — noted'] }),
      scope: 'full',
      artifactTexts: ['# Prior\nearlier output']
    })
    expect(out).toContain('## Activity')
    expect(out).toContain('2026-10-19 11:00 — noted')
    expect(out).toContain('## Prior outputs')
    expect(out).toContain('earlier output')
  })

  it('board scope lists other live cards but not the target card itself', () => {
    const out = buildDelegationContext({
      card: card({ shortname: 'draft-reply', title: 'Draft the reply' }),
      scope: 'board',
      board: [
        card({ shortname: 'draft-reply', title: 'Draft the reply' }),
        card({ shortname: 'book-venue', title: 'Book the venue', status: 'inbox' })
      ]
    })
    expect(out).toContain('## Other cards')
    expect(out).toContain('#book-venue')
    // the target card is not repeated in the roster
    expect(out.match(/#draft-reply/g)).toBeNull()
  })

  it('board scope excludes cards labeled private', () => {
    const out = buildDelegationContext({
      card: card({ shortname: 'draft-reply' }),
      scope: 'board',
      board: [
        card({ shortname: 'book-venue', title: 'Book the venue' }),
        card({ shortname: 'salary-review', title: 'Salary review', labels: ['private'] })
      ]
    })
    expect(out).toContain('#book-venue')
    expect(out).not.toContain('salary-review')
    expect(out).not.toContain('Salary review')
  })
  it('card scope includes user notes but withholds the system log', () => {
    const c = card({
      notes: ['2026-10-19 22:17 — aws_id:abc123'],
      log: ['2026-10-19 22:16 — created', '2026-10-19 22:20 — labels + private']
    })
    const out = buildDelegationContext({ card: c, scope: 'card', text: 'can you see it' })
    expect(out).toContain('## Notes')
    expect(out).toContain('aws_id:abc123')
    expect(out).not.toContain('## Activity')
    expect(out).not.toContain('labels + private') // system log stays hidden at card scope
  })
  it('full scope adds the system activity log', () => {
    const c = card({ log: ['2026-10-19 22:16 — created'] })
    const out = buildDelegationContext({ card: c, scope: 'full', text: 'x' })
    expect(out).toContain('## Activity')
    expect(out).toContain('created')
  })
})
