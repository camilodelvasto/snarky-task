# taskdeck CLI Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A strict CLI layer in front of the resolver: typed commands (`create …`, `/move #x $active`, `@claude`) execute deterministically with no model call; language still flows to the Laya resolver; the feed shows which layer claimed each instruction.

**Architecture:** A pure parser module (`cli.ts`) runs as layer 1 inside the engine pipeline, before split/resolve, covering every input door (feed POST, MCP, hand-written queue files). A claimed parse is patched into the instruction's frontmatter (extended pre-resolved fields) and executes through the existing gates. Collaborators are config-named handles over the already-bound agent/generator capabilities.

**Tech Stack:** TypeScript, vitest, existing engine/handlers/capabilities modules. No new dependencies.

**Spec:** `docs/specs/2026-10-03-taskdeck-cli-design.md`

## Global Constraints

- No-fallbacks rule: a `/`-forced parse failure parks in `attention` with the real error; a bare parse failure *declines* (flows to resolver) — that is routing, and must be visible via the `via` marker.
- Every state change goes through the queue; no privileged side doors.
- `npm run typecheck && npx eslint . && npx vitest run` green before every commit.
- Existing resolver-path behavior unchanged; all existing tests stay green.
- Statuses come from `registry.update_status.params.status` — never hardcode the enum in new code.

---

### Task 1: Types, alias table, instruction frontmatter fields

**Files:**
- Modify: `src/main/tasks/types.ts`
- Modify: `workspace/tasks/registry.json`
- Modify: `src/main/tasks/files.ts` (readInstruction, writeInstruction, patchInstruction)
- Test: `src/main/__tests__/files.test.ts` (extend existing)

**Interfaces:**
- Produces: `Instruction` gains `via?: 'cli' | 'ai'`, `title?: string`, `desc?: string`, `tags?: string[]`, `due?: string`, `with?: string`. `Registry` type gains optional `aliases?: Record<string, string[]>` — note the registry JSON file maps verb → alias array under a top-level `"aliases"` key, and `loadRegistry` already passes unknown top-level keys through (verify; if the Registry type is `Record<string, RegistryEntry>`, change it to an interface with an index signature or a wrapper — see Step 3). `TaskdeckConfig` gains `collaborators?: Record<string, { use: 'agent' | 'generator' }>`.
- Produces: `patchInstruction` accepts the new fields; `writeInstruction`'s `resolved` param widens to `{ action: string; card?: string; to?: string; title?: string; desc?: string; tags?: string[]; due?: string; with?: string; via?: 'cli' | 'ai' }`.

- [ ] **Step 1: Write failing tests** — in `src/main/__tests__/files.test.ts` add:

```ts
it('writeInstruction persists extended pre-resolved fields and readInstruction surfaces them', () => {
  const tasksDir = dir() // use the existing tmp-dir helper in this test file
  const id = writeInstruction(tasksDir, 'create ship it #now $active @claude', new Date('2026-10-03T10:00:00'), {
    action: 'create',
    to: 'active',
    title: 'ship it',
    desc: 'more context',
    tags: ['now'],
    due: '2026-10-03',
    with: 'claude',
    via: 'cli'
  })
  const inst = readInstruction(join(tasksDir, 'queue', `${id}.md`))
  expect(inst.action).toBe('create')
  expect(inst.to).toBe('active')
  expect(inst.title).toBe('ship it')
  expect(inst.desc).toBe('more context')
  expect(inst.tags).toEqual(['now'])
  expect(inst.due).toBe('2026-10-03')
  expect(inst.with).toBe('claude')
  expect(inst.via).toBe('cli')
  expect(inst.raw).toBe('create ship it #now $active @claude')
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run files` → fails (fields undefined).
- [ ] **Step 3: Implement** — in `types.ts` extend `Instruction` with the six optional fields. Registry aliases: the current type is `export type Registry = Record<string, RegistryEntry>`; a top-level `"aliases"` key would collide with action keys. Instead add `aliases` to the REGISTRY FILE under a reserved key and strip it at load: in `registry.json` add

```json
"aliases": {
  "create": ["add", "new"],
  "move": ["mv"],
  "note": ["log"],
  "delete": ["del", "rm"]
}
```

and in `types.ts`:

```ts
export type RegistryAliases = Record<string, string[]>
```

Find `loadRegistry` (in `src/main/tasks/config.ts`) and change its return to `{ registry: Registry; aliases: RegistryAliases }` by splitting the `aliases` key out of the parsed JSON (`const { aliases = {}, ...registry } = parsed`). Update its callers (boot wiring in `src/main/index.ts` or wherever `loadRegistry` is called — grep for it) to destructure. In `TaskdeckConfig` add `collaborators?: Record<string, { use: 'agent' | 'generator' }>`. In `files.ts`: `readInstruction` maps `via`, `title`, `desc`, `tags`, `due`, `with` (same `data.x ?? undefined` pattern as `action`); `writeInstruction`'s `resolved` param carries all fields into frontmatter (skip undefined; `tags` only when non-empty); `patchInstruction`'s `Pick` adds `'via' | 'title' | 'desc' | 'tags' | 'due' | 'with'`.
- [ ] **Step 4: Run, verify PASS** — `npx vitest run` (full suite — loadRegistry callers changed).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: cli groundwork — alias table, extended instruction fields"`

---

### Task 2: The parser (`cli.ts`)

**Files:**
- Create: `src/main/tasks/cli.ts`
- Test: `src/main/__tests__/cli.test.ts`

**Interfaces:**
- Consumes: `Dates` from `../capabilities/contracts` (`extract(text, now) => { due?, cleaned }`), `RegistryAliases` from Task 1.
- Produces:

```ts
export interface CliDeps {
  shortnames: Set<string>        // existing card shortnames, lowercase
  statuses: string[]             // registry.update_status.params.status
  aliases: RegistryAliases       // verb → synonyms
  collaborators: string[]        // Object.keys(config.collaborators ?? {})
  dates: Dates
  now: Date
}
export interface CliCommand {
  action: 'create' | 'update_status' | 'note' | 'link' | 'delete' | 'delegate'
  card?: string
  card2?: string
  to?: string
  title?: string
  desc?: string
  tags: string[]
  due?: string
  with?: string
}
export type CliResult =
  | { kind: 'claimed'; cmd: CliCommand }
  | { kind: 'declined' }               // bare input: not a verb, or grammar failed
  | { kind: 'error'; error: string }   // slash-forced input that failed to parse
export function parseCommand(raw: string, deps: CliDeps): CliResult
```

- [ ] **Step 1: Write failing tests** — create `src/main/__tests__/cli.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseCommand } from '../tasks/cli'

const deps = {
  shortnames: new Set(['press-plan', 'prototype']),
  statuses: ['inbox', 'active', 'waiting', 'done', 'dropped'],
  aliases: { create: ['add', 'new'], move: ['mv'], note: ['log'], delete: ['del', 'rm'] },
  collaborators: ['claude', 'local'],
  dates: {
    extract: (t: string) => (t === 'today' ? { due: '2026-10-03', cleaned: '' } : { cleaned: t })
  },
  now: new Date('2026-10-03T10:00:00')
}

describe('parseCommand — claiming', () => {
  it('parses the spec worked example', () => {
    const r = parseCommand('create submit proposal prototype #urgent $today $active @claude #offline', deps)
    expect(r).toEqual({
      kind: 'claimed',
      cmd: {
        action: 'create',
        title: 'submit proposal prototype',
        tags: ['urgent', 'offline'],
        due: '2026-10-03',
        to: 'active',
        with: 'claude'
      }
    })
  })
  it('maps aliases: "add" and "new" are create, "mv" is move', () => {
    expect(parseCommand('add ship it', deps)).toMatchObject({ kind: 'claimed', cmd: { action: 'create', title: 'ship it' } })
    expect(parseCommand('mv #press-plan $done', deps)).toMatchObject({ kind: 'claimed', cmd: { action: 'update_status', card: 'press-plan', to: 'done' } })
  })
  it('on create every # is a tag; on card verbs a matching # is the ref, non-matching are tags', () => {
    expect(parseCommand('create x #press-plan', deps)).toMatchObject({ cmd: { action: 'create', tags: ['press-plan'] } })
    expect(parseCommand('note #press-plan remember the fonts #ui', deps)).toMatchObject({
      cmd: { action: 'note', card: 'press-plan', title: undefined, tags: ['ui'] }
    })
  })
  it('note free text lands in title-free --text slot', () => {
    const r = parseCommand('note #press-plan remember the fonts', deps)
    expect(r).toMatchObject({ kind: 'claimed', cmd: { action: 'note', card: 'press-plan', desc: undefined } })
    // note text travels as cmd.title? NO — see Produces: note/delegate free text goes to cmd.title. Assert:
    expect((r as { cmd: { title?: string } }).cmd.title).toBe('remember the fonts')
  })
  it('link binds two existing refs', () => {
    expect(parseCommand('link #press-plan #prototype', deps)).toMatchObject({
      kind: 'claimed', cmd: { action: 'link', card: 'press-plan', card2: 'prototype' }
    })
  })
  it('multiline: lines after the first become desc', () => {
    const r = parseCommand('create ship it\nall the context\nsecond line', deps)
    expect(r).toMatchObject({ kind: 'claimed', cmd: { title: 'ship it', desc: 'all the context\nsecond line' } })
  })
})

describe('parseCommand — declining (bare)', () => {
  it('unknown verb declines', () => {
    expect(parseCommand('createx submit proposal', deps)).toEqual({ kind: 'declined' })
  })
  it('known verb with failed grammar declines: note without a #ref', () => {
    expect(parseCommand('note that we should ship', deps)).toEqual({ kind: 'declined' })
  })
  it('bad $token declines: not a status, not a date', () => {
    expect(parseCommand('create x $banana', deps)).toEqual({ kind: 'declined' })
  })
  it('unknown @collaborator declines', () => {
    expect(parseCommand('create x @bob', deps)).toEqual({ kind: 'declined' })
  })
  it('plain language declines', () => {
    expect(parseCommand('we should probably revisit the roadmap', deps)).toEqual({ kind: 'declined' })
  })
})

describe('parseCommand — slash-forced', () => {
  it('/create parses like bare create', () => {
    expect(parseCommand('/create ship it $active', deps)).toMatchObject({ kind: 'claimed', cmd: { action: 'create', to: 'active' } })
  })
  it('unknown /verb errors instead of declining', () => {
    const r = parseCommand('/createx ship it', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/unknown command "createx"/)
  })
  it('known /verb with failed grammar errors with the specific reason', () => {
    const r = parseCommand('/note missing the ref', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/note needs a #card/)
  })
  it('move without a status errors when forced', () => {
    const r = parseCommand('/move #press-plan', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/move needs a \$status/)
  })
  it('leftover free text on move errors when forced', () => {
    expect(parseCommand('/move #press-plan $done asap please', deps).kind).toBe('error')
  })
})

describe('parseCommand — canonical long flags', () => {
  it('parses --title/--status/--tag/--with/--due', () => {
    const r = parseCommand('create --title ship the thing --tag a,b --status active --with claude --due today', deps)
    expect(r).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'create', title: 'ship the thing', tags: ['a', 'b'], to: 'active', with: 'claude', due: '2026-10-03' }
    })
  })
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run cli` → module not found.
- [ ] **Step 3: Implement `src/main/tasks/cli.ts`** — pure function, no I/O:

```ts
import type { Dates } from '../capabilities/contracts'
import type { RegistryAliases } from './types'

// (interfaces exactly as in Produces above)

const VERBS = ['create', 'move', 'note', 'link', 'delete', 'delegate'] as const
type Verb = (typeof VERBS)[number]
const ACTION: Record<Verb, CliCommand['action']> = {
  create: 'create', move: 'update_status', note: 'note',
  link: 'link', delete: 'delete', delegate: 'delegate'
}
const NEEDS_CARD: Verb[] = ['move', 'note', 'link', 'delete', 'delegate']
const TAKES_TEXT: Verb[] = ['create', 'note', 'delegate']

function resolveVerb(token: string, aliases: RegistryAliases): Verb | undefined {
  const t = token.toLowerCase()
  if ((VERBS as readonly string[]).includes(t)) return t as Verb
  for (const [verb, syns] of Object.entries(aliases))
    if (syns.includes(t) && (VERBS as readonly string[]).includes(verb)) return verb as Verb
  return undefined
}

export function parseCommand(raw: string, deps: CliDeps): CliResult {
  const forced = raw.trimStart().startsWith('/')
  const input = forced ? raw.trimStart().slice(1) : raw
  const [first, ...restLines] = input.split('\n')
  const tokens = first.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return forced ? { kind: 'error', error: 'empty command' } : { kind: 'declined' }

  const verb = resolveVerb(tokens[0], deps.aliases)
  if (!verb) return forced ? { kind: 'error', error: `unknown command "${tokens[0]}"` } : { kind: 'declined' }
  const fail = (msg: string): CliResult => (forced ? { kind: 'error', error: msg } : { kind: 'declined' })

  const cmd: CliCommand = { action: ACTION[verb], tags: [] }
  const free: string[] = []
  const args = tokens.slice(1)

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]
    if (tok.startsWith('--')) {
      // canonical long flag: consume value tokens until the next --flag
      const flag = tok.slice(2)
      const val: string[] = []
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) val.push(args[++i])
      const v = val.join(' ')
      if (flag === 'title' || flag === 'text') free.push(v)
      else if (flag === 'desc') cmd.desc = v
      else if (flag === 'tag') cmd.tags.push(...v.split(',').map((s) => s.trim()).filter(Boolean))
      else if (flag === 'status') {
        if (!deps.statuses.includes(v)) return fail(`"${v}" is not a status`)
        cmd.to = v
      } else if (flag === 'with') {
        if (!deps.collaborators.includes(v)) return fail(`unknown collaborator "${v}"`)
        cmd.with = v
      } else if (flag === 'due') {
        const { due } = deps.dates.extract(v, deps.now)
        if (!due) return fail(`cannot parse date "${v}"`)
        cmd.due = due
      } else if (flag === 'card') {
        if (!deps.shortnames.has(v.toLowerCase())) return fail(`no card "#${v}"`)
        if (!cmd.card) cmd.card = v.toLowerCase()
        else cmd.card2 = v.toLowerCase()
      } else return fail(`unknown flag --${flag}`)
    } else if (tok.startsWith('$') && tok.length > 1) {
      const word = tok.slice(1)
      if (deps.statuses.includes(word)) cmd.to = word
      else {
        const { due } = deps.dates.extract(word, deps.now)
        if (!due) return fail(`"$${word}" is neither a status nor a date`)
        cmd.due = due
      }
    } else if (tok.startsWith('@') && tok.length > 1) {
      const name = tok.slice(1)
      if (!deps.collaborators.includes(name)) return fail(`unknown collaborator "@${name}"`)
      cmd.with = name
    } else if (tok.startsWith('#') && tok.length > 1) {
      const word = tok.slice(1).toLowerCase()
      const isRef = verb !== 'create' && deps.shortnames.has(word)
      if (isRef && !cmd.card) cmd.card = word
      else if (isRef && verb === 'link' && !cmd.card2) cmd.card2 = word
      else cmd.tags.push(word)
    } else {
      free.push(tok)
    }
  }

  const text = free.join(' ')
  if (text) cmd.title = text
  const desc = restLines.join('\n').trim()
  if (desc) cmd.desc = cmd.desc ? `${cmd.desc}\n${desc}` : desc

  // per-verb grammar requirements
  if (verb === 'create' && !cmd.title) return fail('create needs a title')
  if (NEEDS_CARD.includes(verb) && !cmd.card) return fail(`${verb} needs a #card`)
  if (verb === 'move' && !cmd.to) return fail('move needs a $status')
  if (verb === 'link' && !cmd.card2) return fail('link needs two #cards')
  if (verb === 'note' && !cmd.title) return fail('note needs text')
  if (verb === 'delegate' && !cmd.with) return fail('delegate needs a @collaborator')
  if (!TAKES_TEXT.includes(verb) && cmd.title) return fail(`${verb} takes no free text`)

  return { kind: 'claimed', cmd }
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run cli`. Fix discrepancies by making the tests' expectations authoritative (they encode the spec).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: cli parser — verbs, aliases, sigils, long flags, claim/decline/error"`

---

### Task 3: handleCreate extensions (title/desc/tags/due/status, no generator on CLI path)

**Files:**
- Modify: `src/main/tasks/handlers.ts` (handleCreate)
- Test: `src/main/__tests__/handlers.test.ts`

**Interfaces:**
- Produces: `handleCreate(ctx, pre, opts?)` where `opts?: { title?: string; desc?: string; tags?: string[]; due?: string; status?: CardStatus }`. With `opts.title` present the generator is NOT called; `opts.desc ?? ''` becomes the description (CLI path must not dump the raw command into the description); `opts.tags → labels`, `opts.due` overrides `pre.due`, `opts.status` overrides `'inbox'`. Without `opts` behavior is unchanged.

- [ ] **Step 1: Write failing tests** — add to `handlers.test.ts`:

```ts
it('create with explicit title skips the generator and applies status/tags/due/desc', async () => {
  const tasksDir = dir()
  const generator = { complete: async () => { throw new Error('generator must not be called') } }
  const shortname = await handleCreate(
    { tasksDir, now, generator },
    { refs: [], cleaned: 'create ship it $active' },
    { title: 'ship it', desc: 'the context', tags: ['urgent'], due: '2026-10-07', status: 'active' }
  )
  const card = readCard(join(tasksDir, 'cards', `${shortname}.md`))
  expect(card.title).toBe('ship it')
  expect(card.description).toBe('the context')
  expect(card.labels).toEqual(['urgent'])
  expect(card.due).toBe('2026-10-07')
  expect(card.status).toBe('active')
})
it('create with explicit title and no desc leaves description empty', async () => {
  const tasksDir = dir()
  const shortname = await handleCreate({ tasksDir, now }, { refs: [], cleaned: 'create ship it' }, { title: 'ship it' })
  expect(readCard(join(tasksDir, 'cards', `${shortname}.md`)).description).toBe('')
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run handlers`.
- [ ] **Step 3: Implement** — change `handleCreate`:

```ts
export async function handleCreate(
  ctx: HandlerCtx,
  pre: PrepassResult,
  opts?: { title?: string; desc?: string; tags?: string[]; due?: string; status?: CardStatus }
): Promise<string> {
  const title = opts?.title
    ? sanitizeTitle(opts.title)
    : ctx.generator
      ? sanitizeTitle(await ctx.generator.complete(TITLE_PROMPT + pre.cleaned))
      : pre.cleaned
  const taken = new Set(readdirSync(join(ctx.tasksDir, 'cards')).map((f) => f.replace(/\.md$/, '')))
  const shortname = slugify(title, taken)
  writeCard(ctx.tasksDir, {
    shortname,
    title,
    status: opts?.status ?? 'inbox',
    created: ctx.now.toISOString().slice(0, 10),
    due: opts?.due ?? pre.due,
    links: pre.refs,
    labels: opts?.tags ?? [],
    description: opts?.title ? (opts?.desc ?? '') : pre.cleaned,
    log: [`${stamp(ctx.now)} — created`]
  })
  return shortname
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run handlers`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: handleCreate accepts cli-parsed fields, skips generator when titled"`

---

### Task 4: Collaborators — config validation and executor refactor

**Files:**
- Modify: `src/main/capabilities/bind.ts`
- Modify: `src/main/tasks/engine.ts` (extract `runExecutor`, add collaborator delegation)
- Test: `src/main/__tests__/capabilities.test.ts`, `src/main/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: `TaskdeckConfig.collaborators` (Task 1).
- Produces: `bindCapabilities` throws at startup if a collaborator's `use` is `'agent'` while no agent is bound/enabled, `'generator'` while no generator is bound, or any other string (`unknown collaborator use "x"`). Engine gains `private runExecutor(executor: 'agent' | 'generator', prompt: string): Promise<string>` (pool-wrapped, used by both `delegate()` and collaborator jobs) and `private delegateToCollaborator(card: string, name: string): Promise<void>` which reads the card, prompts with `"<title>\n\n<description>"`, writes the artifact file and log line exactly as `delegate()` does today (reuse the same artifact-writing code by extracting it; do not duplicate the date-formatting strings).

- [ ] **Step 1: Write failing tests** — in `capabilities.test.ts` add (mirror the existing bindCapabilities test setup in that file):

```ts
it('throws at startup for a collaborator bound to a missing capability', () => {
  const config = {
    resolver: { impl: 'ollama', host: 'http://x', model: 'm' },
    dates: { impl: 'chrono' },
    collaborators: { claude: { use: 'agent' } },  // but no agent section in config
    thresholds: { action: 0.65, card: 0.6, status: 0.6 },
    jobs: { max_parallel: 3 },
    confirmation_timeout_s: 300
  }
  expect(() => bindCapabilities(config as TaskdeckConfig)).toThrow(/collaborator "claude".*agent/)
})
it('throws for an unknown collaborator use value', () => {
  const config = { /* same base */ collaborators: { bob: { use: 'teapot' } } }
  expect(() => bindCapabilities(config as unknown as TaskdeckConfig)).toThrow(/unknown collaborator use "teapot"/)
})
```

In `engine.test.ts` add:

```ts
it('a pre-resolved create with `with` queues a delegation whose artifact lands on the card', async () => {
  const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const s of ['queue', 'cards', 'artifacts']) mkdirSync(join(tasksDir, s), { recursive: true })
  const caps: Capabilities = {
    dates: { extract: (t: string) => ({ cleaned: t }) },
    resolver: { decide: async () => { throw new Error('no resolver on cli path') } },
    agent: { run: async (prompt: string) => `drafted: ${prompt.slice(0, 20)}` }
  }
  const engine = new Engine({
    tasksDir, registry,
    config: { ...config, collaborators: { claude: { use: 'agent' } } },
    caps, onChange: vi.fn(), now: () => new Date('2026-10-02T10:00:00')
  })
  const id = writeInstruction(tasksDir, 'create ship it @claude', new Date('2026-10-02T10:00:00'), {
    action: 'create', title: 'ship it', with: 'claude', via: 'cli'
  })
  await engine.processFile(qpath(tasksDir, id))
  await engine.drain()
  const card = readCard(join(tasksDir, 'cards', 'ship-it.md'))
  expect(card.log.join('\n')).toMatch(/delegated \(claude\)/)
  expect(readdirSync(join(tasksDir, 'artifacts', 'ship-it'))).toHaveLength(1)
})
```

(If `TaskdeckConfig` requires `collaborators` typing, the test `config` import comes from the existing module-level const in `engine.test.ts` — spread it.)

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — in `bind.ts`, after existing bindings, validate:

```ts
for (const [name, c] of Object.entries(config.collaborators ?? {})) {
  if (c.use === 'agent') {
    if (!caps.agent) throw new Error(`collaborator "${name}" needs the agent capability bound and enabled`)
  } else if (c.use === 'generator') {
    if (!caps.generator) throw new Error(`collaborator "${name}" needs the generator capability bound`)
  } else throw new Error(`unknown collaborator use "${(c as { use: string }).use}"`)
}
```

In `engine.ts`, extract from `delegate()` the executor call + artifact write into:

```ts
private async runExecutor(executor: 'agent' | 'generator', prompt: string): Promise<string> {
  return this.pool.run(async () => {
    if (executor === 'generator') {
      if (!this.deps.caps.generator) throw new Error('delegate: generator not bound in config')
      return this.deps.caps.generator.complete(prompt)
    }
    if (!this.deps.caps.agent) throw new Error('delegate: agent not bound in config')
    return this.deps.caps.agent.run(prompt, this.deps.tasksDir)
  })
}

private writeArtifact(card: string, label: string, output: string): void {
  const now = this.now()
  const dir = join(this.deps.tasksDir, 'artifacts', card)
  mkdirSync(dir, { recursive: true })
  const file = `${now.toISOString().slice(0, 16).replace(/:/g, '-')}.md`
  writeFileSync(join(dir, file), output)
  appendLog(
    join(this.deps.tasksDir, 'cards', `${card}.md`),
    `${now.toISOString().slice(0, 16).replace('T', ' ')} — delegated (${label}) → artifacts/${card}/${file}`
  )
  this.refreshCardFacts()
}

private async delegateToCollaborator(card: string, name: string): Promise<void> {
  const use = this.deps.config.collaborators?.[name]?.use
  if (!use) throw new Error(`unknown collaborator "${name}"`)
  const c = readCard(join(this.deps.tasksDir, 'cards', `${card}.md`))
  const output = await this.runExecutor(use, `${c.title}\n\n${c.description}`.trim())
  this.writeArtifact(card, name, output)
}
```

Rewrite the existing `delegate()` to use `runExecutor` + `writeArtifact(card, e.key, output)` (behavior identical; its executor-choice resolver question stays). Note `writeArtifact` calls `refreshCardFacts()` because it appends a log line.
- [ ] **Step 4: Run, verify PASS** — full `npx vitest run` (delegate tests must stay green).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: collaborators — startup validation, executor refactor, collaborator delegation"`

---

### Task 5: Engine pipeline wiring — layer 1 before split/resolve, via markers

**Files:**
- Modify: `src/main/tasks/engine.ts` (pipeline, execute)
- Modify: `src/main/index.ts` or boot wiring (pass aliases into EngineDeps — follow where `loadRegistry` result flows)
- Test: `src/main/__tests__/engine.test.ts`

**Interfaces:**
- Consumes: `parseCommand`/`CliDeps` (Task 2), `handleCreate` opts (Task 3), `delegateToCollaborator` (Task 4), `RegistryAliases` (Task 1).
- Produces: `EngineDeps` gains `aliases: RegistryAliases`. Pipeline order per instruction: meta → already-pre-resolved (`inst.action` set) → CLI parse → split → resolve. A claimed parse is patched into frontmatter (`via: 'cli'` plus all parsed fields) before executing; resolver-path instructions get `via: 'ai'` patched when resolution starts. `execute()` signature gains `opts?: { title?; desc?; tags?; due?; with? }` threaded to `handleCreate` and to a post-create `delegateToCollaborator` call.

- [ ] **Step 1: Write failing tests** — add to `engine.test.ts`:

```ts
describe('Engine CLI layer', () => {
  it('a bare command executes without the resolver and marks via: cli', async () => {
    const { tasksDir, engine } = setup([])  // setup's resolver would answer create/0.9 — assert it is NOT consulted by using a command resolver answers could not produce
    const id = writeInstruction(tasksDir, 'create ship the thing $active #urgent', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.via).toBe('cli')
    const card = readCard(join(tasksDir, 'cards', 'ship-the-thing.md'))
    expect(card.status).toBe('active')
    expect(card.labels).toEqual(['urgent'])
    expect(card.title).toBe('ship the thing')
  })
  it('a slash-forced bad command parks in attention with the parse error', async () => {
    const { tasksDir, engine } = setup([])
    const id = writeInstruction(tasksDir, '/createx ship it', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('attention')
    expect(inst.error).toMatch(/unknown command "createx"/)
  })
  it('a declined bare input flows to the resolver and marks via: ai', async () => {
    const { tasksDir, engine } = setup([{ key: 'create', confidence: 0.9 }])
    const id = writeInstruction(tasksDir, 'createx ship the thing', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.via).toBe('ai')
  })
  it('cli delete still parks at needs_confirmation', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, { shortname: 'proto', title: 'P', status: 'inbox', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
    const id = writeInstruction(tasksDir, 'rm #proto', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('needs_confirmation')
  })
})
```

`setup()` must pass `aliases` into EngineDeps — extend the helper: `aliases: { create: ['add', 'new'], move: ['mv'], note: ['log'], delete: ['del', 'rm'] }`.

- [ ] **Step 2: Run, verify FAIL.**
- [ ] **Step 3: Implement** — in `engine.ts`:
  - `EngineDeps` gains `aliases: RegistryAliases`.
  - In `pipeline()`, after the meta-clean block and after the existing `inst.action` pre-resolved branch condition, insert the CLI layer so the order is: meta → `inst.action` set (drag-drop / replay) → CLI → split/resolve. Concretely restructure to:

```ts
let resolution
let cliOpts: { title?: string; desc?: string; tags?: string[]; due?: string; with?: string } | undefined
if (inst.action) {
  // (existing pre-resolved branch unchanged, but also pick up any stored fields:)
  cliOpts = { title: inst.title, desc: inst.desc, tags: inst.tags, due: inst.due, with: inst.with }
  // ...existing registry check + resolution construction
} else {
  const { cards } = readSnapshot(tasksDir)
  const parsed = parseCommand(raw, {
    shortnames: new Set(cards.map((c) => c.shortname)),
    statuses: (registry.update_status.params?.status ?? []) as string[],
    aliases: this.deps.aliases,
    collaborators: Object.keys(config.collaborators ?? {}),
    dates: caps.dates,
    now: this.now()
  })
  if (parsed.kind === 'error') {
    this.setStatus(path, { status: 'attention', error: parsed.error })
    return
  }
  if (parsed.kind === 'claimed') {
    const { cmd } = parsed
    this.setStatus(path, {
      via: 'cli', action: cmd.action, card: cmd.card, to: cmd.to,
      title: cmd.title, desc: cmd.desc, tags: cmd.tags.length ? cmd.tags : undefined,
      due: cmd.due, with: cmd.with
    })
    cliOpts = { title: cmd.title, desc: cmd.desc, tags: cmd.tags, due: cmd.due, with: cmd.with }
    resolution = { kind: 'action' as const, action: cmd.action, card: cmd.card, status: cmd.to }
    // link carries card2 via pre.refs? NO — thread cmd.card2 through execute opts (see below)
    if (cmd.card2) cliOpts = { ...cliOpts, card2: cmd.card2 } as typeof cliOpts & { card2?: string }
  } else {
    this.setStatus(path, { via: 'ai' })
    // ...existing split + resolve blocks unchanged
  }
}
```

  - `execute()` gains the `opts` param and:
    - `create`: `resolvedCard = await handleCreate(ctx, pre, opts)`; afterwards `if (opts?.with && resolvedCard) await this.delegateToCollaborator(resolvedCard, opts.with)`.
    - `link`: use `opts?.card2 ?? pre.refs[1]` as the second ref (and `card ?? pre.refs[0]` as the first).
    - `note`: when `opts?.title` is set (CLI text), pass it as the note text instead of `raw`: `handleNote(ctx, card!, opts?.title ?? raw)`.
    - `delegate` with `opts?.with`: `await this.delegateToCollaborator(card!, opts.with)` instead of the resolver-choice `delegate()` path.
  - Boot wiring: wherever `loadRegistry` is called (grep `loadRegistry(`), pass `aliases` into the `new Engine({ ... })` deps.
  - The `note` text behavior: CLI note writes only the text to the log, not the whole command line.
- [ ] **Step 4: Run, verify PASS** — full `npx vitest run` (the split/resolve/pre-resolved suites must stay green; `setup()` change touches many tests).
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: engine cli layer — claim/decline/force wiring, via markers, collaborator thread-through"`

---

### Task 6: Feed UI — layer markers and command autocomplete

**Files:**
- Modify: `surfaces/feed/feed.js`
- Modify: `surfaces/feed/feed.css`

**Interfaces:**
- Consumes: `instruction.via` in the snapshot (flows automatically via `readInstruction` from Task 1). `/api/state` snapshot shape otherwise unchanged.

- [ ] **Step 1: Row markers** — in `rowHtml`, after the pill, add a layer marker:

```js
const via = i.via === 'cli' ? '<span class="via cli" title="command">›_</span>'
          : i.via === 'ai' ? '<span class="via ai" title="resolver">✦</span>' : ''
```

and include `${via}` between the pill and `.raw`. In `feed.css`:

```css
.via { flex: none; font: 10px/1 Menlo, monospace; color: var(--text-faint); }
.via.cli { color: var(--s-done); }
.via.ai { color: var(--accent); }
```

- [ ] **Step 2: Command autocomplete** — extend the existing `input` handler. Current code matches `#([a-z0-9-]*)$`. Generalize to three triggers at end of input:
  - `/(\w*)$` only when the `/` is at position 0 → complete verbs + aliases: hardcode the list by fetching once from a new endpoint? NO new endpoint — derive from a static list matching the registry defaults: `['create','add','new','move','mv','note','log','link','delete','del','rm','delegate']`, each hit inserting the verb + space. Display as `/create <title> [$status] [#tag] [@collab]` usage hints (one line each, static strings).
  - `\$([a-z0-9-]*)$` → complete statuses `['inbox','active','waiting','done','dropped']`.
  - `@([a-z]*)$` → complete collaborators — derive from snapshot? Collaborators are config, not snapshot; v1: static `['claude', 'local']` with a `// keep in sync with workspace/tasks/config.json collaborators` comment.
  - `#…` behavior unchanged.
  Implement as a small dispatch: find which trigger matches the input tail, build `acHits` as `{insert, label, hint}` objects, reuse the existing render/accept/arrow/Tab machinery (`acceptHit` generalizes to replace the matched tail with `insert`).
- [ ] **Step 3: Manual verification** — reload the feed view; type `/cr` → menu shows `/create`; Tab completes; `create test $` → status menu; `@` → collaborators; type `createx foo` → row shows `✦` marker after processing; `create foo` → `›_` marker, instant done.
- [ ] **Step 4: Lint** — `npx eslint surfaces/`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: feed cli affordances — layer markers, verb/status/collaborator autocomplete"`

---

### Task 7: Config seed + docs

**Files:**
- Modify: `workspace/tasks/config.json` (add collaborators)
- Modify: `CLAUDE.md` (document the CLI layer briefly)

- [ ] **Step 1: Seed config** — add to `workspace/tasks/config.json`:

```json
"collaborators": {
  "claude": { "use": "agent" },
  "local":  { "use": "generator" }
}
```

- [ ] **Step 2: Docs** — in `CLAUDE.md` under Surfaces/feed, add 4-6 lines: bare verbs (`create|add|new`, `move|mv`, `note|log`, `link`, `delete|del|rm`, `delegate`), sigils (`#tag/#ref`, `$status/$date`, `@collaborator`), `/` forces command mode (fails loud), bare failures flow to the resolver, `›_`/`✦` markers show which layer ran. Point to the spec for the full grammar.
- [ ] **Step 3: Full gate** — `npm run typecheck && npx eslint . && npx vitest run` → all green.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "feat: seed collaborators config; document the cli layer"`
