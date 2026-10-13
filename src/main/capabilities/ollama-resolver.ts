import type { Choice, Resolver } from './contracts'

export class OllamaResolver implements Resolver {
  readonly info: { model?: string }
  constructor(
    private cfg: { host: string; model: string },
    private fetchImpl: typeof fetch = fetch
  ) {
    this.info = { model: cfg.model }
  }

  async decide(q: Choice): Promise<{ key: string; confidence: number }> {
    const keys = q.options.map((o) => o.key)
    const prompt =
      `${q.question}\n\nText: """${q.context}"""\n\nOptions:\n` +
      q.options.map((o) => `- ${o.key} — ${o.description}`).join('\n') +
      `\n\nAnswer with the single best option key and your confidence (0-1).`
    const res = await this.fetchImpl(`${this.cfg.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({
        model: this.cfg.model,
        prompt,
        stream: false,
        // Thinking models (qwen3) otherwise reason for thousands of tokens before the
        // constrained JSON — minutes of pegged CPU for a multiple-choice answer.
        think: false,
        options: { num_predict: 128 },
        format: {
          type: 'object',
          properties: {
            key: { type: 'string', enum: keys },
            confidence: { type: 'number' }
          },
          required: ['key', 'confidence']
        }
      })
    })
    if (!res.ok) throw new Error(`ollama resolver failed: ${res.status} ${await res.text()}`)
    const parsed = JSON.parse(((await res.json()) as { response: string }).response)
    if (!keys.includes(parsed.key))
      throw new Error(`resolver answered outside options: "${parsed.key}"`)
    return { key: parsed.key, confidence: parsed.confidence }
  }
}
