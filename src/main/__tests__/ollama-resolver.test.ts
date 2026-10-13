import { describe, it, expect } from 'vitest'
import { OllamaResolver } from '../capabilities/ollama-resolver'

const q = {
  context: 'proposal for Y got declined',
  question: 'What does this instruction ask for?',
  options: [
    { key: 'create', description: 'start a new task card' },
    { key: 'update_status', description: 'change the status of an existing card' }
  ]
}

describe('OllamaResolver', () => {
  it('constrains to option keys via format schema and returns the parsed decision', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string)
      expect(body.format.properties.key.enum).toEqual(['create', 'update_status'])
      expect(body.stream).toBe(false)
      // thinking models (qwen3) spiral for minutes on CPU; decisions must be bounded
      expect(body.think).toBe(false)
      expect(body.options.num_predict).toBeGreaterThan(0)
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return {
        ok: true,
        json: async () => ({ response: '{"key":"update_status","confidence":0.84}' })
      }
    }) as unknown as typeof fetch
    const r = new OllamaResolver({ host: 'http://h', model: 'm' }, fetchImpl)
    expect(await r.decide(q)).toEqual({ key: 'update_status', confidence: 0.84 })
  })
  it('throws when the model answers outside the options', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({ response: '{"key":"nuke","confidence":0.9}' })
    })) as unknown as typeof fetch
    const r = new OllamaResolver({ host: 'http://h', model: 'm' }, fetchImpl)
    await expect(r.decide(q)).rejects.toThrow(/nuke/)
  })
})
