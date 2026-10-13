import { describe, it, expect } from 'vitest'
import { JobPool } from '../tasks/jobs'
import { OllamaGenerator } from '../capabilities/ollama-generator'
import { ClaudeAgent } from '../capabilities/claude-agent'
import { EventEmitter } from 'events'

describe('JobPool', () => {
  it('caps concurrency', async () => {
    const pool = new JobPool(2)
    let peak = 0
    const job = (): Promise<void> =>
      pool.run(async () => {
        peak = Math.max(peak, pool.active)
        await new Promise((r) => setTimeout(r, 10))
      })
    await Promise.all([job(), job(), job(), job()])
    expect(peak).toBeLessThanOrEqual(2)
  })
})

describe('OllamaGenerator', () => {
  it('posts and returns response text', async () => {
    const fetchImpl = (async (url: string, init: RequestInit) => {
      expect(url).toBe('http://h/api/generate')
      const body = JSON.parse(init.body as string)
      expect(body.stream).toBe(false)
      // thinking models (qwen3) spiral for minutes on CPU; generation must be bounded
      expect(body.think).toBe(false)
      expect(body.options.num_predict).toBeGreaterThan(0)
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return { ok: true, json: async () => ({ response: 'a title' }) }
    }) as unknown as typeof fetch
    const g = new OllamaGenerator({ host: 'http://h', model: 'm' }, fetchImpl)
    expect(await g.complete('p')).toBe('a title')
  })
  it('throws on non-200 with the real error', async () => {
    const fetchImpl = (async () => ({
      ok: false,
      status: 503,
      text: async () => 'down'
    })) as unknown as typeof fetch
    const g = new OllamaGenerator({ host: 'http://h', model: 'm' }, fetchImpl)
    await expect(g.complete('p')).rejects.toThrow(/503/)
  })
})

describe('ClaudeAgent', () => {
  function fakeProc(
    code: number,
    stdout: string,
    stderr = ''
  ): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
    const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
    p.stdout = new EventEmitter()
    p.stderr = new EventEmitter()
    setTimeout(() => {
      if (stdout) p.stdout.emit('data', Buffer.from(stdout))
      if (stderr) p.stderr.emit('data', Buffer.from(stderr))
      p.emit('close', code)
    }, 0)
    return p
  }
  it('returns stdout on success', async () => {
    const spawnImpl = ((cmd: string, args: string[]) => {
      expect(cmd).toBe('claude')
      expect(args).toEqual(['-p', 'draft it'])
      return fakeProc(0, 'the draft')
    }) as never
    expect(await new ClaudeAgent(spawnImpl).run('draft it', '/tmp')).toBe('the draft')
  })
  it('throws with stderr on failure', async () => {
    const spawnImpl = (() => fakeProc(1, '', 'not logged in')) as never
    await expect(new ClaudeAgent(spawnImpl).run('x', '/tmp')).rejects.toThrow(/not logged in/)
  })
})
