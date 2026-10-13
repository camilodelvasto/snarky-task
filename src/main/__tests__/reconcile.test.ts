import { describe, it, expect } from 'vitest'
import { diffCard } from '../tasks/reconcile'

describe('diffCard', () => {
  it('returns nothing for an unseen card (creation logs itself)', () => {
    expect(diffCard(undefined, { status: 'inbox', description: 'x', title: 'T' })).toEqual([])
  })

  it('returns nothing when the watched facts are unchanged (e.g. a log append)', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T' },
        { status: 'inbox', description: 'x', title: 'T' }
      )
    ).toEqual([])
  })

  it('reports a direct status edit', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T' },
        { status: 'active', description: 'x', title: 'T' }
      )
    ).toEqual(['status inbox → active (direct edit)'])
  })

  it('reports a direct title edit', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'A' },
        { status: 'inbox', description: 'x', title: 'B' }
      )
    ).toEqual(['title edited (direct edit)'])
  })

  it('reports a direct description edit', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T' },
        { status: 'inbox', description: 'y', title: 'T' }
      )
    ).toEqual(['description edited (direct edit)'])
  })

  it('reports both when both changed', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T' },
        { status: 'done', description: 'y', title: 'T' }
      )
    ).toEqual(['status inbox → done (direct edit)', 'description edited (direct edit)'])
  })
})
