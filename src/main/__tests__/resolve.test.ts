import { describe, it, expect } from 'vitest'
import { selectCandidates } from '../tasks/candidates'
import { resolveCardRef } from '../tasks/resolve'
import type { Card } from '../tasks/types'
import type { Choice, Resolver } from '../capabilities/contracts'

const card = (shortname: string, title: string, created = '2026-10-01'): Card => ({
  shortname,
  title,
  created,
  path: '',
  status: 'inbox',
  links: [],
  labels: [],
  description: '',
  log: [],
  artifacts: []
})

// scripted resolver: answers queued per question, records asked questions
function scripted(
  answers: Array<{ key: string; confidence: number }>
): Resolver & { asked: Choice[] } {
  const asked: Choice[] = []
  return {
    asked,
    async decide(q: Choice) {
      asked.push(q)
      const a = answers.shift()
      if (!a) throw new Error('no scripted answer left')
      return a
    }
  }
}

describe('selectCandidates', () => {
  it('ranks by keyword overlap', () => {
    const cards = [card('ngo-app', 'NGO application'), card('proposal-y', 'Proposal for Y')]
    const out = selectCandidates('proposal for Y got declined', cards)
    expect(out[0].shortname).toBe('proposal-y')
  })
  it('returns empty with zero overlap', () => {
    expect(selectCandidates('totally unrelated', [card('a', 'B C')])).toEqual([])
  })
})

describe('resolveCardRef', () => {
  it('resolveCardRef puts the whole deck on the ballot (no prefilter, no none option)', async () => {
    const r = scripted([{ key: 'b', confidence: 0.9 }])
    const deck = [card('a', 'Alpha thing'), card('b', 'Beta thing')]
    const res = await resolveCardRef('totally unrelated words', deck, r, 0.6)
    expect(r.asked[0].options.map((o) => o.key)).toEqual(['a', 'b'])
    expect(res).toEqual({ card: 'b', confidence: 0.9 })
  })
  it('parks with keyword suggestions below the gate', async () => {
    const r = scripted([{ key: 'a', confidence: 0.3 }])
    const res = await resolveCardRef('alpha', [card('a', 'Alpha thing'), card('b', 'Beta')], r, 0.6)
    expect(res).toEqual({ error: 'could not resolve target card — did you mean #a?' })
  })
})
