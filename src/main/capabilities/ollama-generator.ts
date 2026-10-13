import type { Generator } from './contracts'

export class OllamaGenerator implements Generator {
  constructor(
    private cfg: { host: string; model: string },
    private fetchImpl: typeof fetch = fetch
  ) {}
  async complete(prompt: string): Promise<string> {
    const res = await this.fetchImpl(`${this.cfg.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.model,
        prompt,
        stream: false,
        // Thinking models (qwen3) otherwise reason for thousands of tokens — minutes of
        // pegged CPU for a one-line answer. Bound everything; a timeout is a real error
        // that parks the instruction in attention, not a silent degradation.
        think: false,
        options: { num_predict: 512 }
      }),
      signal: AbortSignal.timeout(120_000)
    })
    if (!res.ok) throw new Error(`ollama generate failed: ${res.status} ${await res.text()}`)
    return ((await res.json()) as { response: string }).response
  }
}
