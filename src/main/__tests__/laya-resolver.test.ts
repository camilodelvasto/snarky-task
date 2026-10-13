import { describe, it, expect } from 'vitest'
import { LayaResolver, marginConfidence } from '../capabilities/laya-resolver'

describe('LayaResolver', () => {
  it('throws the real error when the checkpoint is missing', async () => {
    const r = new LayaResolver({ checkpoint: '/nope/laya.onnx' })
    await expect(
      r.decide({ context: 'x', question: 'q', options: [{ key: 'a', description: 'a' }] })
    ).rejects.toThrow(/checkpoint not found: \/nope\/laya.onnx/)
  })
})

describe('marginConfidence', () => {
  it('a clear winner is not punished for having one plausible runner-up', () => {
    // entropy confidence on this distribution lands ~0.6; margin sees a decisive win
    const out = marginConfidence({ create: 0.65, delegate: 0.2, note: 0.08, link: 0.07 })
    expect(out.key).toBe('create')
    expect(out.confidence).toBeCloseTo(0.65 / 0.85, 5) // ≈ 0.7647
  })

  it('a genuine two-way split stays below a 0.65 threshold', () => {
    const out = marginConfidence({ create: 0.45, update_status: 0.4, note: 0.15 })
    expect(out.key).toBe('create')
    expect(out.confidence).toBeLessThan(0.65)
  })

  it('a single option is fully confident', () => {
    expect(marginConfidence({ only: 1 })).toEqual({ key: 'only', confidence: 1 })
  })
})
