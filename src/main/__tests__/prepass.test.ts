import { describe, it, expect } from 'vitest'
import { prepass } from '../tasks/prepass'
import { ChronoDates } from '../capabilities/chrono-dates'
import type { Registry } from '../tasks/types'

const registry: Registry = { clean: { class: 'meta' }, create: { class: 'normal' } }
const dates = new ChronoDates()
const now = new Date('2026-10-02T10:00:00')

describe('prepass', () => {
  it('detects meta commands verbatim', () => {
    expect(prepass('clean', dates, now, registry).meta).toBe('clean')
    expect(prepass('clean the house this wed', dates, now, registry).meta).toBeUndefined()
  })
  it('honors the / command sigil on meta words', () => {
    expect(prepass('/clean', dates, now, registry).meta).toBe('clean')
  })
  it('extracts #refs and dates', () => {
    const r = prepass('link #proposal-y to #ngo-app this wed', dates, now, registry)
    expect(r.refs).toEqual(['proposal-y', 'ngo-app'])
    expect(r.due).toBe('2026-10-07')
    expect(r.cleaned).toBe('link #proposal-y to #ngo-app')
  })
})
