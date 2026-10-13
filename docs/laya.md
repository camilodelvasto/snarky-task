# Laya Resolver

This document covers installation, API findings, configuration, and what to verify at runtime.

## Package

`@receptron/laya` v0.1.2 — [npm](https://www.npmjs.com/package/@receptron/laya) | [GitHub](https://github.com/receptron/laya)

Installed via:

```sh
npm install @receptron/laya
```

`onnxruntime-node` is a peer dependency and is pulled in automatically.

## API findings vs. the brief's assumed API

The brief assumed a `choose(context, question, options[])` call. The real API is different:

| Brief assumption | Real API |
|---|---|
| `Laya.load(checkpointPath)` | `Laya.load({ modelDir: '<dir>' })` |
| `model.choose(context, question, options)` | `model.systemOne(state, questions)` |
| Returns `{ index, probability }` | Returns `{ answers.q.choice, answers.q.confidence }` |

### Export name

`Laya` — correct as assumed by the brief.

### Load call

```ts
// Real API — modelDir is a directory, not a single .onnx file
const laya = await Laya.load({ modelDir: './models/laya' })
```

`modelDir` must contain the full ONNX bundle:
- `laya.onnx`
- `laya.onnx.data`
- `laya_config.json`
- `tokenizer/tokenizer.json`
- `tokenizer/tokenizer_config.json`

If `modelDir` is omitted, the package downloads the bundle from Hugging Face
(`convaiinnovations/laya`) into `~/.cache/receptron-laya` on first use.
Budget ~1.7 GB disk space and ~2 GB RAM.

### systemOne call

```ts
const result = await laya.systemOne(
  { context: 'some context text' },   // state — any JSON-serializable object
  {
    q: {
      type: 'choice',
      instructions: 'Which option?',
      criteria: {
        optionKeyA: 'description of A',
        optionKeyB: 'description of B',
      },
    },
  }
)
// result.answers.q.choice       → chosen key string
// result.answers.q.confidence   → calibrated confidence (1 - normalized entropy)
// result.answers.q.probabilities → full distribution

// NOTE: LayaResolver gates on margin confidence computed from `probabilities`
// (p1 / (p1 + p2), top choice vs runner-up), NOT on `confidence`. The entropy-based
// number punishes a clear winner for mass spread across many options — real
// instructions failed a 0.65 threshold at 0.61 while the margin was ~0.97+.
```

## Downloading the bundle

No Python export needed: the package ships a downloader that fetches the **pre-exported** ONNX
bundle from the `receptron/laya-onnx` Hugging Face repo. (The Python `export_onnx.py` route in
the laya repo exists for exporting from the original `convaiinnovations/laya` weights, but the
maintainers already publish the result.)

```js
// download-laya.mjs — run with `node download-laya.mjs` from the project root
import { ensureBundle } from '@receptron/laya'
const dir = await ensureBundle() // → ~/.cache/receptron-laya/receptron--laya-onnx/main
console.log(dir)
```

Then symlink it to the config's checkpoint path:

```sh
mkdir -p models && ln -s ~/.cache/receptron-laya/receptron--laya-onnx/main models/laya
```

`ensureBundle` is idempotent (size-checks each file, atomic temp-file writes) and works offline
once the cache is populated. The `models/` directory is gitignored.

## Intel macOS (darwin/x64): pin onnxruntime-node 1.22.0

`onnxruntime-node` ≥1.23 ships no prebuilt binary for Intel macOS (`darwin/x64` was dropped;
only `darwin/arm64` remains). On an Intel Mac the module throws
`Cannot find module '../bin/napi-v6/darwin/x64/onnxruntime_binding.node'` at import time.

`1.22.0` is the last version with a darwin/x64 binary and still satisfies laya's `^1.22.0`
range, so `package.json` pins it:

```json
"overrides": { "onnxruntime-node": "1.22.0" }
```

This pin is cross-platform, not Intel-specific: the 1.22.0 tarball bundles prebuilt binaries
for darwin/x64, darwin/arm64, Linux, and Windows, so the same committed version runs natively
on both an Intel Mac and Apple Silicon with one lockfile. The only cost is newer runtimes
(≥1.23) being unavailable; remove the override only once no Intel machine builds this repo.

## Configuration

In `config.json`, switch the resolver to Laya:

```json
{
  "resolver": {
    "impl": "laya",
    "checkpoint": "models/laya"
  }
}
```

`checkpoint` is the directory containing the ONNX bundle (passed as `modelDir` to `Laya.load`).

## Manual verification (requires checkpoint)

**Step 5 of the task brief was NOT verified** — no checkpoint was downloaded during implementation
(the models are ~1.7 GB). After downloading the bundle, verify manually:

```sh
npx tsx -e "
import { LayaResolver } from './src/main/capabilities/laya-resolver.js'
const r = new LayaResolver({ checkpoint: 'models/laya' })
const out = await r.decide({
  context: 'The customer paid twice for the same order.',
  question: 'Which team should handle this?',
  options: [
    { key: 'billing', description: 'payments, refunds, invoices' },
    { key: 'support', description: 'product help and bugs' },
  ]
})
console.log(out)
// Expected: { key: 'billing', confidence: <high value near 1> }
"
```

## Packaging note

`onnxruntime-node` contains a native `.node` binary. When packaging with `electron-builder`,
add it to `asarUnpack` in `electron-builder.yml`:

```yaml
asarUnpack:
  - node_modules/onnxruntime-node/**
```

(Do not edit `electron-builder.yml` in this task — this is a reminder for the packaging step.)
