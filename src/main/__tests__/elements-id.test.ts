import { describe, it, expect } from 'vitest'
import { mintId } from '../tasks/elements/id'

describe('mintId', () => {
  it('returns prefix + exactly 4 base36 chars', () => {
    const id = mintId('n', new Set())
    expect(id).toMatch(/^n[0-9a-z]{4}$/)
  })

  it('avoids ids in taken set', () => {
    // Inject a deterministic random source that produces a collision first, then a free id.
    // This proves mintId loops past collisions and returns a free id, without brute-forcing all 1.68M ids.
    const taken = new Set<string>(['naaaa', 'naaab', 'naaac'])
    let callCount = 0
    const injectedRand = () => {
      // First 4 calls produce 'aaaa' (collision in taken)
      // Next 4 calls produce 'aaab' (collision in taken)
      // Next 4 calls produce 'aaac' (collision in taken)
      // Next 4 calls produce 'zzzz' (free id)
      const sequence = 'aaaaaaaaaaaaZzzz'
      return sequence[callCount++].toLowerCase()
    }
    const id = mintId('n', taken, injectedRand)
    expect(id).toBe('nzzzz')
  })

  it('100 sequential mints into one set are all unique', () => {
    const taken = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const id = mintId('e', taken)
      expect(taken.has(id)).toBe(false)
      taken.add(id)
    }
    expect(taken.size).toBe(100)
  })
})
