import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Choice, Resolver } from './contracts'

// Adapter note: the real @receptron/laya API differs from the brief's assumed API.
// - Export name:  `Laya`  — matches the brief's assumption (correct).
// - Load call:    `Laya.load({ modelDir: <dir> })` — NOT `Laya.load(path)`.
//   `cfg.checkpoint` is treated as a directory containing the ONNX bundle
//   (laya.onnx, laya.onnx.data, laya_config.json, tokenizer/).
// - Decide call:  `laya.systemOne(state, questions)` — NOT `model.choose(...)`.
//   Returns `result.answers.q.choice` and `result.answers.q.confidence`.

// Module shim: @receptron/laya ships its own types but electron/vite may not
// resolve them automatically; dynamic import avoids TypeScript path issues.

type SystemOneResponse = {
  answers: Record<
    string,
    { choice: string; confidence: number; probabilities?: Record<string, number> }
  >
}

// Laya's own confidence is 1 − normalized entropy: it punishes a clear winner for merely
// having a plausible runner-up ("create a card: write X" splits create/delegate and fails
// a 0.65 gate at 0.61 even though create won decisively). Gate on the margin instead:
// the head-to-head posterior of the top choice against the runner-up, p1 / (p1 + p2) —
// invariant to option count and to mass spread across distant alternatives.
export function marginConfidence(probabilities: Record<string, number>): {
  key: string
  confidence: number
} {
  const sorted = Object.entries(probabilities).sort((a, b) => b[1] - a[1])
  const [key, p1] = sorted[0]
  if (sorted.length < 2) return { key, confidence: 1 }
  const p2 = sorted[1][1]
  return { key, confidence: p1 + p2 === 0 ? 0 : p1 / (p1 + p2) }
}

type LayaInstance = {
  systemOne(state: unknown, questions: Record<string, unknown>): Promise<SystemOneResponse>
  close(): Promise<void>
}

type LayaStatic = { load(opts?: Record<string, unknown>): Promise<LayaInstance> }

export class LayaResolver implements Resolver {
  private model: LayaInstance | null = null
  readonly info: { model?: string; version?: string }
  constructor(private cfg: { checkpoint: string }) {
    // Weights identity = the checkpoint dir; runtime version fills in at first load.
    this.info = { model: cfg.checkpoint }
  }

  private async load(): Promise<LayaInstance> {
    if (this.model) return this.model
    if (!existsSync(this.cfg.checkpoint))
      throw new Error(`laya checkpoint not found: ${this.cfg.checkpoint}`)
    // ← confirmed export name: `Laya` (matches brief assumption)
    const { Laya } = (await import('@receptron/laya')) as { Laya: LayaStatic }
    // ← real load call: Laya.load({ modelDir }) — brief had Laya.load(path) which is wrong
    this.model = await Laya.load({ modelDir: this.cfg.checkpoint })
    try {
      // The package's exports map blocks module-resolving its package.json (verified:
      // ERR_PACKAGE_PATH_NOT_EXPORTED via both import and require), so read it from disk.
      // In a packaged app the path may differ — version then stays unknown, which is honest.
      const pkgPath = join(process.cwd(), 'node_modules', '@receptron', 'laya', 'package.json')
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version?: string }
      if (pkg.version) this.info.version = `@receptron/laya@${pkg.version}`
    } catch {
      /* version stays unknown — telemetry shows the checkpoint identity only */
    }
    return this.model
  }

  async decide(q: Choice): Promise<{ key: string; confidence: number }> {
    const model = await this.load()
    // Build a `choice` question in systemOne format:
    // criteria is a Record<key, description>
    const criteria: Record<string, string> = {}
    for (const o of q.options) {
      criteria[o.key] = o.description
    }
    // State is the context; the single question key is "q"
    const result = await model.systemOne(
      { context: q.context },
      {
        q: {
          type: 'choice',
          instructions: q.question,
          criteria
        }
      }
    )
    const answer = result.answers.q
    if (answer.probabilities && Object.keys(answer.probabilities).length > 0)
      return marginConfidence(answer.probabilities)
    return { key: answer.choice, confidence: answer.confidence }
  }
}
