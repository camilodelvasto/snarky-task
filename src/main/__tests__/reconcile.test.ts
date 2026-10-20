import { describe, it, expect } from 'vitest'
import { diffCard } from '../tasks/reconcile'

describe('diffCard', () => {
  it('returns nothing for an unseen card (creation logs itself)', () => {
    expect(diffCard(undefined, { status: 'inbox', description: 'x', title: 'T', log: [] })).toEqual(
      []
    )
  })

  it('returns nothing when the watched facts are unchanged (e.g. a log append)', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T', log: [] },
        { status: 'inbox', description: 'x', title: 'T', log: [] }
      )
    ).toEqual([])
  })

  it('reports a direct status edit', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T', log: [] },
        { status: 'active', description: 'x', title: 'T', log: [] }
      )
    ).toEqual(['status inbox → active (direct edit)'])
  })

  it('reports a direct title edit', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'A', log: [] },
        { status: 'inbox', description: 'x', title: 'B', log: [] }
      )
    ).toEqual(['title edited (direct edit)'])
  })

  it('reports a direct description edit', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T', log: [] },
        { status: 'inbox', description: 'y', title: 'T', log: [] }
      )
    ).toEqual(['description edited (direct edit)'])
  })

  it('reports both when both changed', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T', log: [] },
        { status: 'done', description: 'y', title: 'T', log: [] }
      )
    ).toEqual(['status inbox → done (direct edit)', 'description edited (direct edit)'])
  })

  it('returns nothing when the change brings log lines it has not seen (logged at the source)', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T', log: ['a'] },
        { status: 'active', description: 'x', title: 'T', log: ['a', 'b'] }
      )
    ).toEqual([])
  })

  it('still reports a change whose log only lost lines (a hand edit trimming the log)', () => {
    expect(
      diffCard(
        { status: 'inbox', description: 'x', title: 'T', log: ['a', 'b'] },
        { status: 'active', description: 'x', title: 'T', log: ['a'] }
      )
    ).toEqual(['status inbox → active (direct edit)'])
  })
})
