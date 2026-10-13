# Slot Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-found the taskdeck resolution pipeline on per-slot binding: the fork is final (verb/`@collab`/`/` → command, anything else → create), per-action target policy lives in the registry, and the broad AI path (action/status questions, splitter, resolver-picked executors) is deleted.

**Architecture:** The CLI parser (`cli.ts`) decides the fork and binds slots deterministically; grammar failures on recognized commands park loud (no silent reinterpretation as language). The engine fills the one open slot kind that may consult the model — a fuzzy target card — via `resolveCardRef` (whole deck, margin gate), or applies the action's declared target policy (`resolve`/`create`/`required`/`none`) from `registry.json`. Everything that re-derived already-certain slots is removed.

**Tech Stack:** TypeScript (Electron main), vitest, vanilla JS surfaces (no build step).

**Spec:** `docs/specs/2026-10-06-slot-resolution-design.md` (binding authority). The CLI grammar itself remains per `docs/specs/2026-10-03-taskdeck-cli-design.md`.

## Global Constraints

- **No-fallbacks rule:** a binding that fails to load throws at startup; a runtime failure parks the instruction in `attention` with the real error. Nothing silently degrades.
- **Files are state:** every behavior change must round-trip through the queue/card `.md` files; hand edits stay first-class.
- **`/` promises no model:** slash-forced input never reaches `resolveCardRef`; an open target on forced input is a parse error.
- **Legacy tolerance:** old history files may carry `via: ai` and configs may carry `thresholds.action/status` — read them without crashing (warn-and-ignore for config; render legacy `✦` for history). Hand-edited data is never bricked.
- **Gate (run after every task):** `npm run typecheck && npx eslint . --max-warnings 0 && npx vitest run`
- **Commits:** use `git commit -F -` with a heredoc (backticks in `-m` get shell-executed). End every message with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Offline-only; no new dependencies.

## File map

| file | change |
|---|---|
| `src/main/tasks/types.ts` | `TargetPolicy` type; `RegistryEntry.target`; `Instruction.pick`; `TaskdeckConfig.thresholds` → `{ card: number }`; `via` comment |
| `src/main/tasks/registry.ts` | validate `target` values (throw on unknown) |
| `workspace/tasks/registry.json` | add `target` per action; drop `delegate.params.executor` |
| `src/main/tasks/resolve.ts` | delete `resolveInstruction`/`ACTION_DESCRIPTIONS`/`NEEDS_CARD`; `resolveCardRef` returns confidence |
| `src/main/tasks/split.ts` | **delete file** |
| `src/main/tasks/cli.ts` | fork-is-final `fail()`; policy-driven open-target handling; `CliDeps.targetPolicy` |
| `src/main/tasks/engine.ts` | declined → default create; delegate open-target → create+delegate; delete splitter/broad-path/`delegate()`; via = `cli`\|`cli+ai`; store `pick` |
| `src/main/tasks/config.ts` | require `thresholds.card` only; warn-ignore `action`/`status` |
| `src/main/tasks/files.ts` | `pick` in read/patch/write mappings; `via` union widened |
| `workspace/tasks/config.json` | `thresholds: { "card": 0.6 }` |
| `surfaces/feed/feed.js` | drawer shows `card #x ← laya 0.93` when `pick` present |
| `CLAUDE.md`, old CLI spec | doc updates |
| tests | `config-registry`, `cli`, `engine`, `resolve` updated; `split.test.ts` **deleted** |

---

### Task 1: Target policy as registry data

**Files:**
- Modify: `src/main/tasks/types.ts` (RegistryEntry)
- Modify: `src/main/tasks/registry.ts`
- Modify: `workspace/tasks/registry.json`
- Test: `src/main/__tests__/config-registry.test.ts`

**Interfaces:**
- Consumes: existing `loadRegistry(tasksDir)`.
- Produces: `export type TargetPolicy = 'none' | 'resolve' | 'create' | 'required'` in `types.ts`; `RegistryEntry.target?: TargetPolicy`. Later tasks read `registry[action].target ?? 'required'`.

- [ ] **Step 1: Write the failing tests** — append to the existing `loadRegistry` describe block in `config-registry.test.ts` (it already has a `write(dir, obj)`-style helper writing `registry.json` to a tmp dir; reuse the same pattern used by the "unknown class" test):

```ts
it('accepts declared target policies', () => {
  const dir = tmpRegistry({
    create: { class: 'normal', target: 'none' },
    delegate: { class: 'normal', target: 'create' },
    update_status: { class: 'normal', target: 'resolve' },
    note: { class: 'normal', target: 'required' }
  })
  const { registry } = loadRegistry(dir)
  expect(registry.delegate.target).toBe('create')
})

it('throws at startup on an unknown target policy (no-fallbacks)', () => {
  const dir = tmpRegistry({ delegate: { class: 'normal', target: 'banana' } })
  expect(() => loadRegistry(dir)).toThrow(/unknown target "banana"/)
})
```

(`tmpRegistry` = whatever helper the file already uses to write a registry.json into a mkdtemp dir; mirror the existing unknown-class test exactly.)

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/__tests__/config-registry.test.ts` → FAIL (no target validation yet; unknown target currently accepted).

- [ ] **Step 3: Implement** —

`types.ts`:
```ts
export type TargetPolicy = 'none' | 'resolve' | 'create' | 'required'
export interface RegistryEntry {
  class: OperationClass
  // What an open target slot means for this action (spec: per-action target policy).
  // Absent → 'required' (park loud) — safe default for hand-edited registries.
  target?: TargetPolicy
  params?: Record<string, string[]>
}
```

`registry.ts` — inside the existing validation loop:
```ts
const TARGETS = ['none', 'resolve', 'create', 'required']
// …in the for-loop, after the class check:
const t = (entry as { target?: string }).target
if (t !== undefined && !TARGETS.includes(t))
  throw new Error(`registry entry "${key}" has unknown target "${t}"`)
```

`workspace/tasks/registry.json` — full new content (note `delegate` loses `params.executor`; the resolver-picked executor dies in Task 3):
```json
{
  "aliases": {
    "create": ["new"],
    "move": ["mv"],
    "promote": ["upgrade"],
    "backlog": ["downgrade", "demote"],
    "note": ["log"],
    "delete": ["del", "rm", "drop"]
  },
  "create": { "class": "normal", "target": "none" },
  "update_status": { "class": "normal", "target": "resolve", "params": { "status": ["inbox", "active", "waiting", "done", "dropped"] } },
  "note": { "class": "normal", "target": "required" },
  "label": { "class": "normal", "target": "resolve" },
  "unlabel": { "class": "normal", "target": "resolve" },
  "link": { "class": "normal", "target": "required" },
  "delete": { "class": "destructive", "target": "resolve" },
  "delegate": { "class": "normal", "target": "create" },
  "clean": { "class": "meta" }
}
```

- [ ] **Step 4: Run gate** — full gate passes (change is additive; nothing consumes `target` yet).
- [ ] **Step 5: Commit** — `feat: registry declares per-action target policy (slot-resolution spec)`

---

### Task 2: resolveCardRef reports its confidence; engine records `pick`

**Files:**
- Modify: `src/main/tasks/resolve.ts` (return type only)
- Modify: `src/main/tasks/types.ts` (Instruction), `src/main/tasks/files.ts` (field mappings)
- Modify: `src/main/tasks/engine.ts` (needs-card branch)
- Test: `src/main/__tests__/engine.test.ts`

**Interfaces:**
- Produces: `resolveCardRef(...): Promise<{ card: string; confidence: number } | { error: string }>`; `Instruction.pick?: number`. Task 5's drawer reads `i.pick`.

- [ ] **Step 1: Failing test** — in the existing engine test `needs-card: CLI verb + resolver card pick executes and marks via: cli+ai`, add after the `engine` assertion:
```ts
expect(inst.pick).toBeCloseTo(0.95)
```
- [ ] **Step 2: Verify failure** — `npx vitest run src/main/__tests__/engine.test.ts` → FAIL (`pick` undefined).
- [ ] **Step 3: Implement** —
  - `resolve.ts`: success return becomes `return { card: c.key, confidence: c.confidence }`; signature `Promise<{ card: string; confidence: number } | { error: string }>`.
  - `types.ts` Instruction: `pick?: number // margin confidence of a model-bound card slot (via: cli+ai)`.
  - `files.ts`: add `pick: data.pick ?? undefined,` to `readInstruction` (next to `ms`); add `'pick'` to the `patchInstruction` `Pick<...>` union list.
  - `engine.ts` needs-card success branch: add `pick: picked.confidence` to the `setStatus` patch that writes `action/card/to/...`.
- [ ] **Step 4: Gate** — full gate passes.
- [ ] **Step 5: Commit** — `feat: card-pick confidence persisted as instruction frontmatter (pick)`

---

### Task 3: Delete the broad AI path — absence of command means create

This is the deletion task. After it: no action question, no status question, no splitter, no resolver-picked executor, `via` is only ever `cli` or `cli+ai` on new instructions.

**Files:**
- Modify: `src/main/tasks/engine.ts`
- Modify: `src/main/tasks/resolve.ts` (prune), `src/main/tasks/config.ts`, `src/main/tasks/types.ts` (TaskdeckConfig), `src/main/tasks/files.ts` (`via` union in `writeInstruction`'s resolved param)
- Delete: `src/main/tasks/split.ts`, `src/main/__tests__/split.test.ts`
- Modify: `workspace/tasks/config.json`
- Test: `src/main/__tests__/engine.test.ts`, `src/main/__tests__/resolve.test.ts`, plus any fixture carrying `thresholds` (grep `thresholds` across `src/`)

- [ ] **Step 1: Write the failing engine tests** — replace the test `a declined bare input flows to the resolver and marks via: ai` with:

```ts
it('language captures: no verb → create, no resolver call, via: cli', async () => {
  const { tasksDir, engine } = setup([]) // strict resolver (see below): any call throws
  const id = writeInstruction(tasksDir, 'gotta fix the balcony door', new Date('2026-10-02T10:00:00'))
  await engine.processFile(qpath(tasksDir, id))
  const inst = readInstruction(qpath(tasksDir, id))
  expect(inst.status).toBe('done')
  expect(inst.via).toBe('cli')
  expect(inst.action).toBe('create')
  expect(readdirSync(join(tasksDir, 'cards'))).toHaveLength(1)
})

it('a question pushed at the system is capture, never mutation', async () => {
  const { tasksDir, engine } = setup([])
  writeCard(tasksDir, {
    shortname: 'record-screencasts', title: 'record screencasts', status: 'active',
    created: '2026-10-01', links: [], labels: [], description: '', log: []
  })
  const id = writeInstruction(tasksDir, 'what is a screencast?', new Date('2026-10-02T10:00:00'))
  await engine.processFile(qpath(tasksDir, id))
  const inst = readInstruction(qpath(tasksDir, id))
  expect(inst.action).toBe('create')
  expect(readCard(join(tasksDir, 'cards', 'record-screencasts.md')).status).toBe('active') // untouched
})
```

To make "no resolver call" airtight, change `setup([])`'s resolver fallback from `{ key: 'create', confidence: 0.9 }` to `(() => { throw new Error('resolver must not be consulted') })()` **only when the answers array is empty at construction** — i.e. give `setup` a second shape: `setup([])` now means *the resolver throws if consulted*. Concretely:

```ts
resolver: {
  decide: async (_q: Choice) => {
    const a = answers.shift()
    if (!a) throw new Error('resolver consulted with no scripted answer')
    return a
  }
}
```

This is stricter for every existing test too — the rewrites below account for it.

- [ ] **Step 2: Rewrite the engine tests that depended on broad resolution** (same file, same step — these fail under the stricter resolver until Step 4):
  - `create: queued → done, card exists` — keep input `write the ngo proposal`, change `setup([{ key: 'create', confidence: 0.9 }])` → `setup([])`. It now exercises the create default.
  - `attention freezes the card: later instructions stay queued` — rewrite to produce the attention via a delegation failure (CLI-parsed, zero resolver):
    ```ts
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, { shortname: 'p-y', title: 'proposal y', status: 'active',
      created: '2026-10-01', links: [], labels: [], description: '', log: [] })
    const first = writeInstruction(tasksDir, 'delegate #p-y @local draft the reply', new Date('2026-10-02T10:00:00'))
    const second = writeInstruction(tasksDir, 'note on #p-y status update', new Date('2026-10-02T10:00:01'))
    await engine.processFile(qpath(tasksDir, first))
    await engine.processFile(qpath(tasksDir, second))
    expect(readInstruction(qpath(tasksDir, first)).status).toBe('attention') // generator not bound
    expect(readInstruction(qpath(tasksDir, second)).status).toBe('queued')   // frozen
    ```
    This requires the shared test `config` const to gain `collaborators: { local: { use: 'generator' } }` (caps in `setup` bind no generator, so the delegation throws `delegate: generator not bound in config` — a real no-fallbacks park).
  - `requeue unfreezes and reprocesses` — same mechanism: first instruction `delegate #x @local research it` (card `x` written as today) → attention; then `engine.requeue(id, 'make a brand new card')` → drain → single queue file, status done (create default).
  - `requeue without text unfreezes resolver-resolved card (no #refs in body)` — **delete this test** with a comment: the status-question attention that carried a resolver-resolved card no longer exists; frontmatter-card unfreeze is still covered by the delete/requeue tests that freeze via `#refs`.
  - `destructive parks as needs_confirmation…`, boot re-derive test, TOCTOU test, deleteInstruction test, clean-sweep test — inputs are already CLI-claimed (`delete #a`, `note on #p-y status`, …); change their `setup([...])` scripted answers to `setup([])` and delete the now-unused `answersA`/`answersB` resolver scripting in the boot test (replace those inline caps with the same throwing resolver shape). Run them; they must pass unchanged otherwise.
  - `a resolver-path instruction records the resolver engine and duration` — rewrite: the only resolver path left is needs-card. Use `writeCard` for `munich-conference` + input `promote the munich thing`, `setup([{ key: 'munich-conference', confidence: 0.95 }])`, assert `inst.engine` is `'cli+test'` and `typeof inst.ms` is `'number'`. (The pure-`laya` engine string now only appears on `cli+` prefixed hybrids.)
  - `a resolver that self-describes gets its model and version recorded` — same conversion: give that bespoke caps block a card + `promote the munich thing` input and assert `inst.model === 'models/laya'`, `inst.version === '@receptron/laya@0.1.2'` on the hybrid path.

- [ ] **Step 3: Verify failures** — `npx vitest run src/main/__tests__/engine.test.ts` → the new/rewritten tests FAIL (declined input still routes to `resolveInstruction`).

- [ ] **Step 4: Implement the engine deletion** — in `engine.ts`:
  - Remove imports of `splitInstruction` and `resolveInstruction`; import stays for `resolveCardRef`.
  - Replace the entire `else { /* Declined by CLI */ ... }` branch (the `via: 'ai'` patch, splitter block, and `resolveInstruction` try/catch) with:
    ```ts
    } else {
      // No verb, no leading @collaborator, no slash: language is captured.
      // Nobody — and no model — picks the action (spec: absence of command
      // means create). The create handler owns title cleanup, due extraction,
      // #ref links, #tag labels via prepass.
      resolution = { kind: 'action' as const, action: 'create' }
    }
    ```
  - Via computation becomes `const via: 'cli' | 'cli+ai' = hybrid ? 'cli+ai' : 'cli'`.
  - `telemetry(path, via)` signature narrows to `'cli' | 'cli+ai'`; the `'cli+ai'` branch keeps reporting `cli+${r.impl}` + model/version; delete the plain-`ai` branch.
  - `execute(...)` via param type `'cli' | 'cli+ai' = 'cli'`; in `confirm()`, map legacy frontmatter: `inst.via === 'cli+ai' ? 'cli+ai' : 'cli'`.
  - Delete the `delegate(card, raw)` method. In `execute()`'s delegate arm:
    ```ts
    else if (action === 'delegate') {
      if (!opts?.with) throw new Error('delegate needs a collaborator')
      await this.delegateToCollaborator(card!, opts.with, opts?.title)
    }
    ```
  - `files.ts`: widen the `writeInstruction` resolved-param `via?: 'cli' | 'ai'` to `'cli' | 'ai' | 'cli+ai'` (the `'ai'` literal stays read-tolerated; nothing in the engine emits it anymore).
- [ ] **Step 5: Prune resolve.ts and its tests** — delete `resolveInstruction`, `ACTION_DESCRIPTIONS`, `NEEDS_CARD`, the `Resolution` type, and the now-unused `Registry`/`PrepassResult` imports; the file keeps only `resolveCardRef` (+ its doc comment) and imports (`Card`, `Resolver`, `selectCandidates`). In `resolve.test.ts` delete the five `resolveInstruction` tests and the `registry`/`thresholds` consts; keep `selectCandidates` tests; add:
    ```ts
    it('resolveCardRef puts the whole deck on the ballot (no prefilter, no none option)', async () => {
      const r = scripted([{ key: 'b', confidence: 0.9 }])
      const deck = [card('a', 'Alpha thing'), card('b', 'Beta thing')]
      const res = await resolveCardRef('totally unrelated words', deck, r, 0.6)
      expect(r.asked[0].options.map((o) => o.key)).toEqual(['a', 'b'])
      expect(res).toEqual({ card: 'b', confidence: 0.9 })
    })
    it('parks with keyword suggestions below the gate', async () => {
      const r = scripted([{ key: 'a', confidence: 0.3 }])
      const res = await resolveCardRef('alpha', [card('a', 'Alpha thing'), card('b', 'Beta')], r, 0.6)
      expect(res).toEqual({ error: 'could not resolve target card — did you mean #a?' })
    })
    ```
- [ ] **Step 6: Delete the splitter** — `git rm src/main/tasks/split.ts src/main/__tests__/split.test.ts`.
- [ ] **Step 7: Config shrink** — `config.ts`: replace the three-threshold loop with:
    ```ts
    if (typeof raw.thresholds.card !== 'number')
      throw new Error('config.json missing required field: thresholds.card')
    for (const t of ['action', 'status'])
      if (raw.thresholds[t] !== undefined)
        console.warn(`config.json thresholds.${t} is obsolete (slot resolution) — ignored`)
    ```
    `types.ts`: `thresholds: { card: number }`. `workspace/tasks/config.json`: `"thresholds": { "card": 0.6 }`. Grep `thresholds` across `src/` and shrink every test fixture/config literal to `{ card: 0.6 }` (engine, server, config-registry suites).
- [ ] **Step 8: Gate** — full suite green, eslint clean (watch for unused imports in engine.ts).
- [ ] **Step 9: Commit** — `feat: absence of command means create — broad AI path deleted (action/status questions, splitter, executor pick)`

---

### Task 4: CLI fork-is-final + policy-driven targets; delegate open-target creates its workspace

**Files:**
- Modify: `src/main/tasks/cli.ts`
- Modify: `src/main/tasks/engine.ts` (parse deps + claimed-branch mapping)
- Test: `src/main/__tests__/cli.test.ts`, `src/main/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: `TargetPolicy` from Task 1; engine create-then-delegate motion (existing `handleCreate` + `opts.with` advance).
- Produces: `CliDeps.targetPolicy: Record<string, TargetPolicy>` (keyed by **action**, not verb). Engine builds it as `Object.fromEntries(Object.entries(registry).map(([k, v]) => [k, v.target ?? 'required']))`.

- [ ] **Step 1: Failing cli tests** — the shared `deps` fixture gains:
```ts
targetPolicy: {
  create: 'none', update_status: 'resolve', label: 'resolve', unlabel: 'resolve',
  delete: 'resolve', note: 'required', link: 'required', delegate: 'create'
}
```
New/changed expectations:
```ts
// fork is final: recognized-verb grammar failures are errors even bare
it('bare grammar failure parks loud — no silent reinterpretation as language', () => {
  const r = parseCommand('note that we should ship', deps)
  expect(r.kind).toBe('error')
  expect((r as { error: string }).error).toMatch(/note needs a #card/)
})
it('bare sigil failure parks loud too', () => {
  const r = parseCommand('create x $banana', deps)
  expect(r.kind).toBe('error')
})
// non-verb input still declines (engine captures it)
it('non-verb input declines to capture', () => {
  expect(parseCommand('createx submit proposal', deps)).toEqual({ kind: 'declined' })
})
it('unknown @word is not a fork trigger — declines to capture', () => {
  expect(parseCommand('@bob do something #press-plan', deps)).toEqual({ kind: 'declined' })
})
// delegate: open target means create-workspace
it('delegate with text and no card claims — the work creates its own workspace', () => {
  expect(parseCommand('@local what is a screencast?', deps)).toMatchObject({
    kind: 'claimed',
    cmd: { action: 'delegate', with: 'local', card: undefined, title: 'what is a screencast?' }
  })
})
it('delegate with neither card nor text still fails', () => {
  const r = parseCommand('@local', deps)
  expect(r.kind).toBe('error')
})
```
Also update existing expectations that asserted `declined` for verb-claimed failures: `promote #press-plan asap` → error (`promote takes no free text`); `create x @bob` → error (`unknown collaborator`); `move the munich thing` (no `$status`) → error. The needs-card tests stay as-is (policy `resolve` reproduces them); `/promote the munich thing` stays an error (`/` promises no model).

- [ ] **Step 2: Verify failures** — `npx vitest run src/main/__tests__/cli.test.ts` → FAIL on each new expectation.

- [ ] **Step 3: Implement cli.ts** —
  - `CliDeps` gains `targetPolicy: Record<string, TargetPolicy>` (import type from `./types`).
  - **Fork-is-final fail:** once a verb is bound, failures are errors regardless of `forced`. Replace the `fail` helper definition (currently `forced ? error : declined`) with `const fail = (msg: string): CliResult => ({ kind: 'error', error: msg })` — note it is defined *after* verb resolution, so the pre-verb paths (`empty`, `unknown first token`, unknown `@word`) keep their current declined/forced-error behavior untouched.
  - **Policy-driven open target** — replace the `NEEDS_CARD`-and-`BARE_REF_VERBS` block:
    ```ts
    if (NEEDS_CARD.includes(verb) && !cmd.card) {
      const policy = deps.targetPolicy[ACTION[verb]] ?? 'required'
      // resolve: free text names the card — narrow model pick (bare input only;
      // `/` promises no model and fails loud).
      if (policy === 'resolve' && text && !forced)
        return { kind: 'needs-card', cmd: finalize({ ...cmd, title: undefined }), query: text }
      // create: free text is the brief — the work creates its own workspace.
      if (policy === 'create' && cmd.title) {
        if (verb === 'delegate' && !cmd.with) return fail('delegate needs a @collaborator')
        return { kind: 'claimed', cmd: finalize(cmd) }
      }
      return fail(`${verb} needs a #card`)
    }
    ```
  - The deterministic bare-ref slug/prefix block above it: replace its `BARE_REF_VERBS.includes(verb)` condition with `deps.targetPolicy[ACTION[verb]] === 'resolve'` and delete the `BARE_REF_VERBS` const. (Exact-slug and unique-prefix matching remain instrument #2 — they run before any model.)
  - Keep the later per-verb checks (`delegate needs a @collaborator`, `takes no free text`, …) unchanged — they now emit errors on bare input via the new `fail`.
- [ ] **Step 4: Engine mapping for delegate-create** — failing engine test first:
    ```ts
    it('@local with no card creates the workspace card and delegates to it', async () => {
      const { tasksDir, engine } = setup([])
      // caps for this test bind a generator so the delegation succeeds:
      // reuse the bespoke-caps pattern from the collaborator-delegation suite,
      // generator: { complete: async () => 'A screencast is a recorded demo.' }
      const id = writeInstruction(tasksDir, '@local what is a screencast?', new Date('2026-10-02T10:00:00'))
      await engine.processFile(qpath(tasksDir, id))
      const inst = readInstruction(qpath(tasksDir, id))
      expect(inst.status).toBe('done')
      expect(inst.via).toBe('cli')
      expect(inst.action).toBe('delegate') // frontmatter advanced by the create+with motion
      expect(inst.card).toBe('what-is-a-screencast')
      expect(readCard(join(tasksDir, 'cards', 'what-is-a-screencast.md')).title).toBe('what is a screencast?')
      expect(readdirSync(join(tasksDir, 'artifacts', 'what-is-a-screencast'))).toHaveLength(1)
    })
    ```
    (Build this test with its own `Engine` + caps literal like the existing `Engine collaborator delegation` suite does — `setup()` binds no generator.)
    Implementation in `engine.ts`'s `parsed.kind === 'claimed'` branch — after `const { cmd } = parsed`, insert:
    ```ts
    // Open target under a 'create' policy: the work creates its own workspace.
    // Route through the existing create-then-delegate motion (crash-replay safe:
    // frontmatter advances create → delegate after the card exists).
    const action =
      !cmd.card && (registry[cmd.action]?.target ?? 'required') === 'create' && cmd.action !== 'create'
        ? 'create'
        : cmd.action
    ```
    and use `action` (not `cmd.action`) in the `setStatus` patch and the `resolution` literal of that branch. `cliOpts` already carries `with`/`title`, which is all `handleCreate` + the `with` advance need.
  - `parseCommand` deps in the engine gain `targetPolicy` (expression in Interfaces above).
- [ ] **Step 5: Gate** — full suite green.
- [ ] **Step 6: Commit** — `feat: fork is final — policy-driven targets; delegate open-target creates its workspace`

---

### Task 5: Telemetry surface, docs, live config

**Files:**
- Modify: `surfaces/feed/feed.js` (drawer), `surfaces/feed/feed.css` (pick styling)
- Modify: `CLAUDE.md`, `docs/specs/2026-10-03-taskdeck-cli-design.md`
- Test: manual (surfaces have no test harness); full gate for the repo

- [ ] **Step 1: Drawer slot attribution** — in `drawerHtml`, replace the card row:
```js
${i.card ? kv('card', `#${esc(i.card)}${i.pick ? ` <span class="pick">← ${esc((i.engine ?? '').replace(/^cli\+/, '') || 'resolver')} ${Number(i.pick).toFixed(2)}</span>` : ''}`) : ''}
```
and add to `feed.css` (near the drawer rules): `.pick { color: var(--ink-3, #8a8a86); font-size: 10px; }` — match the drawer's existing muted-value styling; reuse its variables, don't invent new ones.
- [ ] **Step 2: CLAUDE.md** — in the CLI Layer section, replace the "Bare failures flow to the resolver…" sentence with:
> Recognized commands that fail their grammar park loud; input with no verb is **captured as a card** (absence of command means create). A claimed verb with a fuzzy card ref gets exactly one model question — which card — shown as `via: cli+ai` (`›_✦`). See `docs/specs/2026-10-06-slot-resolution-design.md`.

Update the config example's `thresholds` to `{ "card": 0.6 }` and delete the sentence about resolver-chosen delegate executors if present.
- [ ] **Step 3: Old spec note** — in `2026-10-03-taskdeck-cli-design.md`, directly under the layer table, add:
> **Superseded (2026-10-06):** layers 1.5–2 as described here are replaced by the slot-resolution model — see `docs/specs/2026-10-06-slot-resolution-design.md`. The grammar, sigils, aliases, and `/` semantics in this document remain authoritative.
- [ ] **Step 4: Full gate + manual QA list** — run the gate; then note in the commit body the manual checks for the human: restart app → `@local what is a screencast?` creates + delegates; `what is a screencast?` creates; `note that we should ship` parks; drawer on a `›_✦` row shows `card #x ← laya 0.93`.
- [ ] **Step 5: Commit** — `feat: slot telemetry in the drawer; docs re-founded on slot resolution`

---

## Self-review (done at plan time)

- **Spec coverage:** fork-is-final → T4; create default → T3; target policy registry data → T1 (+T4 consumption); deletions list → T3; `required` parks → T4 (grammar errors); telemetry/markers → T2+T5 (feed `›_✦` marker already ships); legacy `via: ai` render-only → already in feed.js, untouched; config warn-ignore → T3; edge table rows each land in a T3/T4 test or an existing cli test.
- **Type consistency:** `TargetPolicy` (T1) consumed by `CliDeps.targetPolicy` and engine mapping (T4); `resolveCardRef` `{ card, confidence }` (T2) consumed by engine `pick` (T2) and drawer (T5); thresholds `{ card }` (T3) used by needs-card gate only.
- **Known intentional behavior changes** (called out for the reviewer): bare sigil/grammar failures park instead of falling through; unknown `@word` captures; `delegate #card` without collaborator parks at parse (resolver executor pick deleted).
