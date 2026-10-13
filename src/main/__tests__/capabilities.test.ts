import { describe, it, expect } from 'vitest'
import { ChronoDates } from '../capabilities/chrono-dates'
import { bindCapabilities } from '../capabilities/bind'
import type { TaskdeckConfig } from '../tasks/types'

describe('ChronoDates', () => {
  const dates = new ChronoDates()
  const now = new Date('2026-10-02T10:00:00') // a Friday
  it('extracts "this wed" as the upcoming Wednesday and cleans the text', () => {
    const r = dates.extract('gotta write the ngo proposal this wed', now)
    expect(r.due).toBe('2026-10-07')
    expect(r.cleaned).toBe('gotta write the ngo proposal')
  })
  it('returns no due date when none is present', () => {
    const r = dates.extract('proposal for Y got declined', now)
    expect(r.due).toBeUndefined()
    expect(r.cleaned).toBe('proposal for Y got declined')
  })
})

describe('bindCapabilities', () => {
  const base: TaskdeckConfig = {
    resolver: { impl: 'ollama', host: 'http://x', model: 'm' },
    dates: { impl: 'chrono' },
    thresholds: { card: 0.6 },
    jobs: { max_parallel: 3 },
    confirmation_timeout_s: 300
  }
  it('throws on unknown impl — no fallback', () => {
    expect(() => bindCapabilities({ ...base, dates: { impl: 'vibes' } })).toThrow(/vibes/)
  })
  it('binds chrono dates and leaves generator/agent unbound when absent', () => {
    const caps = bindCapabilities(base)
    expect(caps.dates).toBeDefined()
    expect(caps.generator).toBeUndefined()
    expect(caps.agent).toBeUndefined()
  })
  it('throws at startup for a collaborator bound to a missing capability', () => {
    const config = {
      resolver: { impl: 'ollama', host: 'http://x', model: 'm' },
      dates: { impl: 'chrono' },
      collaborators: { claude: { use: 'agent' } }, // but no agent section in config
      thresholds: { card: 0.6 },
      jobs: { max_parallel: 3 },
      confirmation_timeout_s: 300
    }
    expect(() => bindCapabilities(config as TaskdeckConfig)).toThrow(/collaborator "claude".*agent/)
  })
  it('throws for an unknown collaborator use value', () => {
    const config = { ...base, collaborators: { bob: { use: 'teapot' } } }
    expect(() => bindCapabilities(config as unknown as TaskdeckConfig)).toThrow(
      /unknown collaborator use "teapot"/
    )
  })
})
