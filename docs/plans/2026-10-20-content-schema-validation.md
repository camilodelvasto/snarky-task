# Content Schema & Validation (Tier 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give snarky-task's card/instruction model a declared, versioned JSON Schema with boundary validation and atomic writes — the moui "schema as contract" pattern — without touching the CLI or ops.

**Architecture:** Two bundled draft-07 JSON Schemas describe the card and instruction *frontmatter*. A `validate.ts` module (ajv) validates parsed frontmatter against the schema named by the file's `v:` field. Writers stamp `v: 1`, validate before writing, and write atomically (temp + rename). Readers validate and throw precise errors on invalid files (existing callers already skip-and-log). A `check` meta command validates the whole workspace into the instruction's `result`. The markdown body stays markdown; its section split is hardened to line-anchored matching.

**Tech Stack:** TypeScript (Electron main), ajv@6 (draft-07, already present — pin as a direct dep), vitest.

**Spec:** `docs/specs/2026-10-20-content-schema-validation-design.md` (binding authority).

## Global Constraints

- **Scope is Tier 1 only:** schemas, validation, `v:` versioning, atomic writes, `check`, body-split hardening. Do NOT change handlers, the CLI parser, ops routing, or add content types. Do NOT add UI surfacing or quarantine (Tier 1.5).
- **JSON Schema validates frontmatter, not the markdown body.** description/notes/log stay in the body.
- **ajv is version 6.12.6** (already in node_modules transitively): draft-07 by default; API is `import Ajv from 'ajv'; const ajv = new Ajv({ allErrors: true }); const v = ajv.compile(schema); v(data) → boolean; v.errors`. Pin it in package.json dependencies (`"ajv": "6.12.6"`). No other new deps.
- **No-fallbacks:** a validation failure is a real error (throw / loud skip), never a silent coercion. Writers must never persist invalid frontmatter.
- **`additionalProperties: false`** on both schemas (catch field typos).
- **Files are state; hand edits are first-class.** Readers that already `try/catch` (readSnapshot, engine boot) keep skipping-and-logging; validation makes their errors precise.
- Gate after every task: `npm run typecheck && npx eslint . --max-warnings 0 && npx vitest run`.
- Commits: `git commit -F -` heredoc (never `-m`). **Plain messages, no Co-Authored-By trailers.**
- Offline-only.

## File map

| file | change |
|---|---|
| `package.json` | pin `ajv` as a direct dependency |
| `src/main/tasks/schema/card.v1.json` | **new** — card frontmatter schema |
| `src/main/tasks/schema/instruction.v1.json` | **new** — instruction frontmatter schema |
| `src/main/tasks/validate.ts` | **new** — `validateCard`/`validateInstruction` (ajv) |
| `src/main/tasks/files.ts` | `writeFileAtomic`; `v:1` on write; validate on read+write; line-anchored body split |
| `src/main/tasks/engine.ts` | atomic artifact writes; `check` meta handler |
| `workspace/templates/default/registry.json` + live project registries | add `check` meta action |
| tests | `validate.test.ts`, extend `files.test.ts`, `engine.test.ts` |
| `electron.vite.config.ts` / build | ensure `schema/*.json` is readable at runtime (see Task 2) |

---

### Task 1: ajv dependency + the two schemas

**Files:**
- Modify: `package.json`
- Create: `src/main/tasks/schema/card.v1.json`, `src/main/tasks/schema/instruction.v1.json`
- Test: none (data files; exercised in Task 2)

**Interfaces:**
- Produces: two JSON Schema files consumed by `validate.ts` (Task 2).

- [ ] **Step 1: Pin ajv.** In `package.json`, add to `dependencies` (keep alphabetical if the block is sorted): `"ajv": "6.12.6"`. Run `npm install` to update `package-lock.json` (ajv is already present, so this is a no-op install that records the direct dep). Verify `node -e "console.log(require('ajv/package.json').version)"` prints `6.12.6`.

- [ ] **Step 2: Create `src/main/tasks/schema/card.v1.json`** verbatim:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "card.v1.json",
  "title": "snarky-task Card (frontmatter)",
  "type": "object",
  "additionalProperties": false,
  "required": ["title", "status", "created", "links", "labels"],
  "properties": {
    "v": { "type": "integer", "const": 1 },
    "title": { "type": "string", "minLength": 1 },
    "status": { "type": "string", "enum": ["inbox", "active", "waiting", "done", "dropped"] },
    "created": { "type": "string", "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
    "due": { "type": "string" },
    "links": { "type": "array", "items": { "type": "string" } },
    "labels": { "type": "array", "items": { "type": "string" } }
  }
}
```

- [ ] **Step 3: Create `src/main/tasks/schema/instruction.v1.json`** verbatim:

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "instruction.v1.json",
  "title": "snarky-task Instruction (frontmatter)",
  "type": "object",
  "additionalProperties": false,
  "required": ["status"],
  "properties": {
    "v": { "type": "integer", "const": 1 },
    "status": { "type": "string", "enum": ["queued", "working", "needs_confirmation", "attention", "done"] },
    "action": { "type": "string" },
    "card": { "type": "string" },
    "to": { "type": "string" },
    "title": { "type": "string" },
    "desc": { "type": "string" },
    "tags": { "type": "array", "items": { "type": "string" } },
    "due": { "type": "string" },
    "with": { "type": "string" },
    "scope": { "type": "string", "enum": ["card", "full", "board"] },
    "via": { "type": "string", "enum": ["cli", "ai", "cli+ai"] },
    "engine": { "type": "string" },
    "model": { "type": "string" },
    "version": { "type": "string" },
    "ms": { "type": "number" },
    "pick": { "type": "number" },
    "error": { "type": "string" },
    "result": { "type": "string" }
  }
}
```

- [ ] **Step 4: Gate** — full gate (unused files, so just confirms nothing broke).
- [ ] **Step 5: Commit** — `feat: pin ajv; declare card/instruction frontmatter JSON Schemas (tier 1)`

---

### Task 2: validate.ts

**Files:**
- Create: `src/main/tasks/validate.ts`
- Test: `src/main/__tests__/validate.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3–4):
  ```ts
  export interface ValidationError { field: string; message: string }
  export function validateCard(frontmatter: unknown): ValidationError[]        // [] when valid
  export function validateInstruction(frontmatter: unknown): ValidationError[] // [] when valid
  export function formatErrors(errors: ValidationError[]): string              // "field: message; field2: message2"
  ```
- Behavior: selects the schema by `(frontmatter as { v?: number }).v ?? 1`. An unsupported version returns `[{ field: 'v', message: 'schema version <n> not supported' }]`. ajv errors map to `{ field, message }` where `field` is the dotted instancePath without the leading slash (empty path → the keyword's params, e.g. an additionalProperty uses `error.params.additionalProperty` as the field).

**Import note:** the schemas are JSON files imported at module load. In this TS/electron-vite setup, import them with `import cardSchemaV1 from './schema/card.v1.json'` (resolveJsonModule is on — verify in tsconfig; if off, read them with `readFileSync(join(__dirname, 'schema', 'card.v1.json'), 'utf-8')` + `JSON.parse`, which also survives bundling more predictably). **Use the readFileSync approach** to avoid bundler JSON-inlining surprises in the packaged app; resolve the dir as `join(__dirname, 'schema')`.

- [ ] **Step 1: Write the failing tests** — `src/main/__tests__/validate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { validateCard, validateInstruction, formatErrors } from '../tasks/validate'

const okCard = {
  v: 1, title: 'Press plan', status: 'active', created: '2026-10-01', links: [], labels: ['urgent']
}
const okInst = { v: 1, status: 'done', action: 'create', ms: 12 }

describe('validateCard', () => {
  it('accepts a valid card frontmatter', () => {
    expect(validateCard(okCard)).toEqual([])
  })
  it('accepts a legacy card with no v (defaults to 1)', () => {
    const { v, ...noV } = okCard
    expect(validateCard(noV)).toEqual([])
  })
  it('rejects a bad status enum', () => {
    const errs = validateCard({ ...okCard, status: 'activ' })
    expect(errs.some((e) => e.field === 'status')).toBe(true)
  })
  it('rejects a missing required field', () => {
    const { title, ...noTitle } = okCard
    expect(validateCard(noTitle).some((e) => e.field === 'title' || e.message.includes('title'))).toBe(true)
  })
  it('rejects an unknown property (typo guard)', () => {
    const errs = validateCard({ ...okCard, tittle: 'x' })
    expect(errs.some((e) => e.field === 'tittle' || e.message.includes('tittle'))).toBe(true)
  })
  it('rejects a bad created pattern', () => {
    expect(validateCard({ ...okCard, created: '10/01/2026' }).some((e) => e.field === 'created')).toBe(true)
  })
  it('rejects an unsupported schema version', () => {
    expect(validateCard({ ...okCard, v: 2 })).toEqual([{ field: 'v', message: 'schema version 2 not supported' }])
  })
})

describe('validateInstruction', () => {
  it('accepts a valid instruction', () => {
    expect(validateInstruction(okInst)).toEqual([])
  })
  it('rejects a bad via enum', () => {
    expect(validateInstruction({ ...okInst, via: 'magic' }).some((e) => e.field === 'via')).toBe(true)
  })
  it('rejects a non-number ms', () => {
    expect(validateInstruction({ ...okInst, ms: 'fast' }).some((e) => e.field === 'ms')).toBe(true)
  })
})

describe('formatErrors', () => {
  it('joins field: message pairs', () => {
    expect(formatErrors([{ field: 'status', message: 'bad' }, { field: 'v', message: 'x' }]))
      .toBe('status: bad; v: x')
  })
})
```

- [ ] **Step 2: Verify failure** — `npx vitest run src/main/__tests__/validate.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `src/main/tasks/validate.ts`:**

```ts
import Ajv, { type ValidateFunction, type ErrorObject } from 'ajv'
import { readFileSync } from 'fs'
import { join } from 'path'

export interface ValidationError {
  field: string
  message: string
}

const schemaDir = join(__dirname, 'schema')
const ajv = new Ajv({ allErrors: true })

// version → compiled validator, per entity. Only v1 exists today.
const cardValidators: Record<number, ValidateFunction> = {
  1: ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'card.v1.json'), 'utf-8')))
}
const instructionValidators: Record<number, ValidateFunction> = {
  1: ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'instruction.v1.json'), 'utf-8')))
}

function run(
  validators: Record<number, ValidateFunction>,
  frontmatter: unknown
): ValidationError[] {
  const v = (frontmatter as { v?: number })?.v ?? 1
  const validate = validators[v]
  if (!validate) return [{ field: 'v', message: `schema version ${v} not supported` }]
  if (validate(frontmatter)) return []
  return (validate.errors ?? []).map(toError)
}

function toError(e: ErrorObject): ValidationError {
  // additionalProperties reports the offending key in params; else use the instancePath
  const extra = (e.params as { additionalProperty?: string }).additionalProperty
  const field = extra ?? e.instancePath.replace(/^\//, '') || e.keyword
  const message = extra ? `unknown property "${extra}"` : e.message ?? 'invalid'
  return { field, message }
}

export function validateCard(frontmatter: unknown): ValidationError[] {
  return run(cardValidators, frontmatter)
}
export function validateInstruction(frontmatter: unknown): ValidationError[] {
  return run(instructionValidators, frontmatter)
}
export function formatErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.field}: ${e.message}`).join('; ')
}
```

Note: ajv@6 default-exports the class (`import Ajv from 'ajv'`). If the TS config complains about esModuleInterop, use `import Ajv = require('ajv')` or confirm `esModuleInterop: true` in tsconfig.node.json (it is — default-import works). The schemas must be copied next to the built file; see Task 2 Step 5.

- [ ] **Step 4: Run tests → PASS.**
- [ ] **Step 5: Bundling — ensure `schema/*.json` ships beside the built `validate.js`.** electron-vite builds `src/main` to `out/main`. The `readFileSync(join(__dirname, 'schema', …))` resolves relative to the built file, so the JSON must be copied into `out/main/schema/`. In `electron.vite.config.ts`, add the schema dir to the main build's static copy (if the project already uses `vite-plugin-static-copy` or electron-vite's `resources`, follow that; otherwise add a `build.rollupOptions` copy or a tiny `copyFileSync` in a build hook). Concretely: add a Vite plugin to the `main` config:
  ```ts
  {
    name: 'copy-task-schemas',
    closeBundle() {
      const from = resolve(__dirname, 'src/main/tasks/schema')
      const to = resolve(__dirname, 'out/main/schema')
      cpSync(from, to, { recursive: true })
    }
  }
  ```
  (import `cpSync` from 'fs', `resolve` from 'path'.) Vitest runs against source (`__dirname` = `src/main/tasks`), so tests find `src/main/tasks/schema/` directly — no build needed for tests. Verify `npm run build` produces `out/main/schema/card.v1.json`.
- [ ] **Step 6: Full gate.**
- [ ] **Step 7: Commit** — `feat: validate.ts — ajv validation of card/instruction frontmatter by version`

---

### Task 3: files.ts — v:1, validation at boundaries, atomic writes, body-split hardening

**Files:**
- Modify: `src/main/tasks/files.ts`
- Test: `src/main/__tests__/files.test.ts`

**Interfaces:**
- Consumes: `validateCard`, `validateInstruction`, `formatErrors` (Task 2).
- Produces: unchanged public signatures for `writeCard`/`readCard`/`writeInstruction`/`readInstruction`/`patchInstruction`; internally they now stamp `v:1`, validate, and write atomically. A new internal `writeFileAtomic(path, data)`.
- Current frontmatter writers (exact, for reference): `writeInstruction` builds `data` then `writeFileSync(queue/<id>.md, matter.stringify(body, data))`; `patchInstruction` merges and `writeFileSync(path, matter.stringify(content, merged))`; `writeCard` builds `front` then `writeFileSync(path, matter.stringify(body, front))`. `readCard` splits body with `content.split(LOG_HEADER)` then `.split(NOTES_HEADER)`. `appendLog` uses `appendFileSync` (leave as-is).

- [ ] **Step 1: Write failing tests** — add to `files.test.ts`:

```ts
it('writeCard stamps v:1 and the frontmatter validates', () => {
  const dir = freshTasksDir()
  const path = writeCard(dir, {
    shortname: 'c', title: 'C', status: 'inbox', created: '2026-10-02',
    links: [], labels: [], description: 'x', log: []
  })
  const raw = readFileSync(path, 'utf-8')
  expect(raw).toMatch(/^v: 1$/m)
  expect(() => readCard(path)).not.toThrow()
})
it('readCard throws a precise error on a schema-invalid card', () => {
  const dir = freshTasksDir()
  const path = join(dir, 'cards', 'bad.md')
  writeFileSync(path, matter.stringify('\nbody\n\n## Log\n', { title: 'Bad', status: 'nope', created: '2026-10-02', links: [], labels: [] }))
  expect(() => readCard(path)).toThrow(/invalid against card\.v1\.json.*status/)
})
it('writeCard refuses to persist invalid frontmatter', () => {
  const dir = freshTasksDir()
  // status not in the enum — our own code should never write this
  expect(() =>
    writeCard(dir, {
      shortname: 'c', title: 'C', status: 'bogus' as never, created: '2026-10-02',
      links: [], labels: [], log: [], description: ''
    })
  ).toThrow(/invalid/)
})
it('a description containing the literal "## Log" is preserved (line-anchored split)', () => {
  const dir = freshTasksDir()
  const path = writeCard(dir, {
    shortname: 'c', title: 'C', status: 'inbox', created: '2026-10-02', links: [], labels: [],
    description: 'see the section ## Log inline here', log: ['2026-10-02 10:00 — created']
  })
  const card = readCard(path)
  expect(card.description).toContain('## Log inline here')
  expect(card.log).toEqual(['2026-10-02 10:00 — created'])
})
it('writeInstruction stamps v:1 and reads back valid', () => {
  const dir = freshTasksDir()
  const id = writeInstruction(dir, 'hello', new Date('2026-10-02T10:00:00'))
  const raw = readFileSync(join(dir, 'queue', `${id}.md`), 'utf-8')
  expect(raw).toMatch(/^v: 1$/m)
  expect(readInstruction(join(dir, 'queue', `${id}.md`)).status).toBe('queued')
})
it('writeFileAtomic leaves no temp files behind', () => {
  const dir = freshTasksDir()
  writeCard(dir, { shortname: 'c', title: 'C', status: 'inbox', created: '2026-10-02', links: [], labels: [], description: '', log: [] })
  expect(readdirSync(join(dir, 'cards')).every((f) => !f.startsWith('.') || f === '.gitkeep')).toBe(true)
})
```

(Ensure `readFileSync`, `writeFileSync`, `matter`, `readdirSync` are imported in the test — add any missing.)

- [ ] **Step 2: Verify failures.**
- [ ] **Step 3: Implement in `files.ts`:**
  - Add imports: `import { validateCard, validateInstruction, formatErrors } from './validate'`; add `renameSync`, `readdirSync` are not needed here — only `writeFileSync` replaced. Add `randomBytes` is already imported.
  - Add the atomic helper:
    ```ts
    function writeFileAtomic(path: string, data: string): void {
      const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(3).toString('hex')}.tmp`)
      writeFileSync(tmp, data)
      renameSync(tmp, path)
    }
    ```
    (add `dirname` to the `path` import, `renameSync` to the `fs` import.)
  - `writeCard`: set `front = { v: 1, title, status, ...due, links, labels }` (v first). Before writing, `const errs = validateCard(front); if (errs.length) throw new Error(\`card "${card.shortname}" invalid: ${formatErrors(errs)}\`)`. Replace `writeFileSync(path, …)` with `writeFileAtomic(path, …)`.
  - `writeInstruction`: initialize `const data: Record<string, unknown> = { v: 1, status: 'queued' }`. After assembling `data`, `const errs = validateInstruction(data); if (errs.length) throw new Error(\`instruction invalid: ${formatErrors(errs)}\`)`. Replace `writeFileSync` with `writeFileAtomic`.
  - `patchInstruction`: after building `merged` (and deleting undefined keys), set `merged.v = merged.v ?? 1`, validate: `const errs = validateInstruction(merged); if (errs.length) throw new Error(\`instruction patch invalid: ${formatErrors(errs)}\`)`. Replace `writeFileSync` with `writeFileAtomic`.
  - `readCard`: line-anchor the split. Replace `const [beforeLog, logPart] = content.split(LOG_HEADER)` and the notes split with regex splits:
    ```ts
    const [beforeLog, logPart] = splitSection(content, LOG_HEADER)
    const [desc, notesPart] = splitSection(beforeLog, NOTES_HEADER)
    ```
    where
    ```ts
    function splitSection(text: string, header: string): [string, string | undefined] {
      const m = text.match(new RegExp(`^${header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*$`, 'm'))
      if (!m || m.index === undefined) return [text, undefined]
      return [text.slice(0, m.index), text.slice(m.index + m[0].length)]
    }
    ```
    (This anchors on a whole line equal to the header.) After parsing frontmatter, validate: `const errs = validateCard(data); if (errs.length) throw new Error(\`${path} invalid against card.v1.json: ${formatErrors(errs)}\`)`. Place the validation right after `matter(...)` and before building the return object.
  - `readInstruction`: after `matter(...)`, validate: `const errs = validateInstruction(data); if (errs.length) throw new Error(\`${path} invalid against instruction.v1.json: ${formatErrors(errs)}\`)`.
- [ ] **Step 4: Run tests → PASS. Run the whole suite** — existing engine/server/snapshot tests write cards/instructions through these functions, so they exercise validation end-to-end. If any pre-existing test fixture writes a frontmatter the schema rejects (e.g. a card with an unexpected field, or an instruction with a stray key), that is a real finding: fix the fixture to match the schema (the schema is the spec of valid data). Do NOT loosen the schema to pass a malformed fixture.
- [ ] **Step 5: Full gate.**
- [ ] **Step 6: Commit** — `feat: validate + atomically write card/instruction files; stamp v:1; line-anchor body split`

---

### Task 4: `check` meta command

**Files:**
- Modify: `src/main/tasks/engine.ts`, the registries (`workspace/templates/default/registry.json` and every live `workspace/projects/*/tasks/registry.json`)
- Test: `src/main/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: `validateCard`/`validateInstruction`/`formatErrors` (import into engine.ts), the meta-routing pattern already used by `clean`/`clear` (`pre.meta === 'check'`).
- Produces: a `check` run that validates every `.md` in `cards/`, `queue/`, and `history/`, and writes a report to the instruction's `result` frontmatter, status `done`, `via: cli`.

- [ ] **Step 1: Failing engine test** — add to `engine.test.ts` (the fixture registry already lists meta actions; add `check`):

```ts
it('check validates the workspace and reports invalids in result', async () => {
  const { tasksDir, engine } = setup([])
  // one valid card, one hand-broken card (bad status, written raw to dodge writeCard validation)
  writeCard(tasksDir, { shortname: 'good', title: 'Good', status: 'active', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
  writeFileSync(
    join(tasksDir, 'cards', 'broken.md'),
    matter.stringify('\n\n## Log\n', { title: 'Broken', status: 'nope', created: '2026-10-01', links: [], labels: [] })
  )
  const id = writeInstruction(tasksDir, 'check', new Date('2026-10-02T10:00:00'))
  await engine.processFile(qpath(tasksDir, id))
  const inst = readInstruction(qpath(tasksDir, id))
  expect(inst.status).toBe('done')
  expect(inst.result).toMatch(/1 invalid/)
  expect(inst.result).toContain('cards/broken.md')
  expect(inst.result).toContain('status')
})
it('check on a clean workspace reports all valid and mutates nothing', async () => {
  const { tasksDir, engine } = setup([])
  writeCard(tasksDir, { shortname: 'good', title: 'Good', status: 'active', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
  const before = readFileSync(join(tasksDir, 'cards', 'good.md'), 'utf-8')
  const id = writeInstruction(tasksDir, 'check', new Date('2026-10-02T10:00:00'))
  await engine.processFile(qpath(tasksDir, id))
  expect(readInstruction(qpath(tasksDir, id)).result).toMatch(/all valid/)
  expect(readFileSync(join(tasksDir, 'cards', 'good.md'), 'utf-8')).toBe(before) // untouched
})
```

- [ ] **Step 2: Verify failure** (check unhandled → likely parks as unknown meta / no handler).
- [ ] **Step 3: Implement.**
  - engine.ts imports: add `validateCard, validateInstruction, formatErrors` from `./validate`, and `readFileSync` is already imported; `matter`? No — read frontmatter via the existing `readInstruction`/`readCard` would THROW on invalid (defeating the point). So `check` must parse frontmatter WITHOUT the throwing readers. Use gray-matter directly: add `import matter from 'gray-matter'` to engine.ts, and for each file do `const { data } = matter(readFileSync(p, 'utf-8'))` then validate `data`.
  - Add the handler after the `pre.meta === 'clear'` block:
    ```ts
    if (pre.meta === 'check') {
      const dirs: Array<[string, (fm: unknown) => ReturnType<typeof validateCard>]> = [
        ['cards', validateCard],
        ['queue', validateInstruction],
        ['history', validateInstruction]
      ]
      let total = 0
      const bad: string[] = []
      for (const [sub, check] of dirs) {
        const d = join(tasksDir, sub)
        if (!existsSync(d)) continue
        for (const f of readdirSync(d).filter((n) => n.endsWith('.md'))) {
          if (sub === 'queue' && join(d, f) === path) continue // skip this instruction itself
          total++
          try {
            const { data } = matter(readFileSync(join(d, f), 'utf-8'))
            const errs = check(data)
            if (errs.length) bad.push(`${sub}/${f}: ${formatErrors(errs)}`)
          } catch (err) {
            bad.push(`${sub}/${f}: unreadable (${err instanceof Error ? err.message : String(err)})`)
          }
        }
      }
      const result = bad.length
        ? `checked ${total} files — ${bad.length} invalid\n${bad.join('\n')}`
        : `checked ${total} files — all valid`
      this.setStatus(path, { status: 'done', via: 'cli', result, ...this.telemetry(path, 'cli') })
      return
    }
    ```
  - Registries: add `"check": { "class": "meta" }` to `workspace/templates/default/registry.json` and each live `workspace/projects/*/tasks/registry.json`. Add `check: { class: 'meta' }` to the `engine.test.ts` fixture registry.
- [ ] **Step 4: Run tests → PASS. Full gate.**
- [ ] **Step 5: Commit** — `feat: check meta command — validate the whole workspace, report invalids in the drawer`

---

### Task 5: drift guard + docs

**Files:**
- Test: `src/main/__tests__/validate.test.ts` (append)
- Modify: `CLAUDE.md`, `surfaces/feed/feed.js` (autocomplete hint + done-head copy), `surfaces/feed/index.html` (placeholder)

- [ ] **Step 1: Schema/type drift guard.** Append a test asserting every frontmatter key the writers emit is a declared schema property — so adding a field to a writer without the schema fails loudly:

```ts
import cardSchema from '../tasks/schema/card.v1.json'
import instrSchema from '../tasks/schema/instruction.v1.json'

describe('schema ↔ writer drift', () => {
  // Keys writeCard emits into frontmatter (see files.ts writeCard):
  const cardKeys = ['v', 'title', 'status', 'created', 'due', 'links', 'labels']
  // Keys writeInstruction/patchInstruction emit (see files.ts):
  const instrKeys = ['v', 'status', 'action', 'card', 'to', 'title', 'desc', 'tags', 'due', 'with', 'scope', 'via', 'engine', 'model', 'version', 'ms', 'pick', 'error', 'result']
  it('every card writer key is a declared card schema property', () => {
    for (const k of cardKeys) expect(Object.keys(cardSchema.properties)).toContain(k)
  })
  it('every instruction writer key is a declared instruction schema property', () => {
    for (const k of instrKeys) expect(Object.keys(instrSchema.properties)).toContain(k)
  })
})
```

(This import uses `resolveJsonModule` — verify it's enabled in `tsconfig.node.json`; it is used elsewhere. If vitest complains, read+JSON.parse instead.)

- [ ] **Step 2: Run → PASS.**
- [ ] **Step 3: Docs + surface copy.**
  - `CLAUDE.md`: in the Data layout or Architecture section, add one paragraph: cards and instructions carry a `v:` schema version and are validated against bundled JSON Schemas (`src/main/tasks/schema/`) at read and write; `check` validates the whole workspace. Point to `docs/specs/2026-10-20-content-schema-validation-design.md`.
  - `surfaces/feed/feed.js`: add a `/check` entry to `AC_VERBS` (`{ insert: 'check', label: '/check', hint: 'validate every card & instruction' }`), and extend the done-head copy string to mention it alongside clean/clear if that line lists meta commands.
  - `surfaces/feed/index.html`: extend the placeholder to mention `check` (e.g. "… 'clear' wipes, 'check' validates").
- [ ] **Step 4: Full gate (incl. `npm run build` once to confirm `out/main/schema/` is populated).**
- [ ] **Step 5: Commit** — `feat: schema/writer drift guard; document content validation and the check command`

---

## Self-review (done at plan time)

- **Spec coverage:** schemas → T1; validate.ts → T2; bundling → T2 Step 5; v:1 + read/write validation + atomic writes + body-split hardening → T3; check command → T4; drift guard + docs → T5. Every spec section maps to a task.
- **Type consistency:** `ValidationError { field, message }`, `validateCard`/`validateInstruction`/`formatErrors` defined in T2, consumed identically in T3/T4/T5. `writeFileAtomic(path, data)` defined and used only within files.ts (T3). `check` meta string consistent across engine handler, registries, and fixture (T4).
- **Known risks called out:** (1) existing test fixtures may write frontmatter the schema rejects — T3 Step 4 says fix the fixture, not the schema; (2) ajv@6 default-import interop — T2 note; (3) schema bundling into `out/main` — T2 Step 5 with a build verification; (4) `check` must parse with raw gray-matter, not the throwing readers — T4 Step 3.
