# Projects & Templates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One deck per concern — projects are switchable workspace directories (`workspace/projects/<name>/tasks`), the active project is a one-line file (`workspace/current`), and new projects seed from template folders.

**Architecture:** A pure-fs project library (`projects.ts`) does migration/list/create/trash; a `ProjectManager` owns the running Engine and rebinds it when `workspace/current` changes (written by the CLI verb, the board switcher, a hand edit, or a git pull — all converge on the file). The `project` CLI verb is a new parse kind routed by the engine to injected project ops; `project rm` rides the existing destructive-confirmation gate via a `project_rm` registry action and moves the dir to `workspace/.trash/`. The server reads tasksDir/engine/ui through accessors so a switch re-points it without restart.

**Tech Stack:** TypeScript (Electron main), vitest, vanilla-JS surfaces, chokidar (already a dep).

**Spec:** `docs/specs/2026-10-15-projects-templates-design.md` (binding authority).

## Global Constraints

- **Files are the state:** the switch IS `workspace/current`; `project rm` moves to `workspace/.trash/<ISO-stamp>-<name>/`, never deletes. Hand edits to `current` are first-class switches.
- **No-fallbacks:** a project whose config/registry fails to load parks the *switch instruction* in attention with the real error; the engine stays on the old project. Unknown template/project names park with the real error and the list of valid names.
- **Fork is final:** `project` grammar failures park loud (error kind), bare or `/`-forced.
- Project/template names are slugs: `/^[a-z0-9-]+$/`. `default` cannot be removed; removing the active project switches to `default` first.
- **Migration is one-time and reversible:** `workspace/tasks` exists && `workspace/projects` doesn't → move to `workspace/projects/default/tasks`, write `current` = `default`.
- Gate after every task: `npm run typecheck && npx eslint . --max-warnings 0 && npx vitest run`.
- Commits: `git commit -F -` heredoc (never `-m` — backticks execute in zsh). **Plain messages, no Co-Authored-By trailers.**
- Offline-only; no new dependencies.

## File map

| file | change |
|---|---|
| `src/main/tasks/projects.ts` | **new** — pure fs project ops (migrate/list/create/trash/current) |
| `src/main/project-manager.ts` | **new** — owns Engine lifecycle, watches `current`, exposes ProjectOps |
| `src/main/tasks/cli.ts` | `project` verb → new `{ kind: 'project' }` result |
| `src/main/tasks/engine.ts` | route kind `project` to injected ops; `project_rm` through the confirm gate |
| `src/main/tasks/types.ts` | `Instruction.result`; `Snapshot.project`; ProjectOps type |
| `src/main/tasks/files.ts` | `result` in read/patch mappings |
| `src/main/index.ts` | boot through ProjectManager |
| `src/main/server.ts` | accessor-based opts; project info in snapshot/SSE |
| `surfaces/board/board.js` + `board.css` | topbar project switcher |
| `surfaces/feed/feed.js` | `project ` autocomplete; drawer renders `result` |
| `workspace/templates/{gtd,renovation,business-canvas}/cards/*` | **new** — starter decks (tracked) |
| `.gitignore`, `workspace/tasks/registry.json` → per-project, `CLAUDE.md` | layout rework + docs |

---

### Task 1: Project fs library

**Files:**
- Create: `src/main/tasks/projects.ts`
- Test: `src/main/__tests__/projects.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 3–4):
  ```ts
  export const PROJECT_SLUG = /^[a-z0-9-]+$/
  export function resolveRoot(appRoot: string): string               // workspace root resolution (see below)
  export function migrateWorkspace(root: string): boolean            // true when it migrated
  export function listProjects(root: string): string[]               // sorted dir names under projects/
  export function listTemplates(root: string): string[]              // sorted dir names under templates/ ([] if absent)
  export function currentProject(root: string): string               // reads current; absent → 'default'
  export function writeCurrent(root: string, name: string): void     // validates slug + existence, writes file
  export function projectTasksDir(root: string, name: string): string // join(root,'projects',name,'tasks')
  export function createProject(root: string, name: string, now: Date, template?: string): void
  export function trashProject(root: string, name: string, now: Date): string // returns trash path
  ```
- `resolveRoot(appRoot)` — the working directory is user-definable. Resolution order:
  (1) `XWEB_WORKSPACE` env var when set; (2) the first line of `~/.config/snarky-task/root`
  when that file exists and names an existing directory (trimmed; `~` expanded via
  `os.homedir()`; a non-existent path logs a console.warn and falls through — a stale
  pointer must not brick boot); (3) `join(appRoot, 'workspace')`. Test all three branches
  (set env in-test via a parameter default you can override: `resolveRoot(appRoot, env, cfgPath)`
  with production defaults `process.env.XWEB_WORKSPACE` and `join(homedir(), '.config', 'snarky-task', 'root')`).
- Behavior contracts:
  - `createProject`: throws on bad slug, existing name, or unknown template. Scaffolds `tasks/{queue,cards,history,artifacts}`; copies `config.json`/`registry.json` from the template dir when present, else from `projects/default/tasks/`, else errors `no default project to scaffold from`. Template cards are copied via `readCard`/`writeCard` with `created` reset to `now` (YYYY-MM-DD) and `log` reset to `[ '<stamp> — created' ]` (same stamp format as handlers: `now.toISOString().slice(0, 16).replace('T', ' ')`).
  - `trashProject`: throws for `default`, unknown names; moves dir to `<root>/.trash/<now ISO, colons → '-'>-<name>/` (mkdir -p `.trash`).
  - `writeCurrent`: throws for unknown project (message includes `listProjects` names).

- [ ] **Step 1: Write the failing tests** — `src/main/__tests__/projects.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  migrateWorkspace, listProjects, listTemplates, currentProject, writeCurrent,
  projectTasksDir, createProject, trashProject
} from '../tasks/projects'
import { writeCard, readCard } from '../tasks/files'

const now = new Date('2026-10-15T10:00:00')

function root(): string {
  return mkdtempSync(join(tmpdir(), 'td-root-'))
}
/** A root with a default project carrying config+registry (the post-migration shape). */
function seeded(): string {
  const r = root()
  const t = join(r, 'projects', 'default', 'tasks')
  for (const s of ['queue', 'cards', 'history', 'artifacts']) mkdirSync(join(t, s), { recursive: true })
  writeFileSync(join(t, 'config.json'), '{"resolver":{"impl":"x"}}')
  writeFileSync(join(t, 'registry.json'), '{"create":{"class":"normal"}}')
  return r
}

describe('projects fs library', () => {
  it('migrates workspace/tasks → projects/default/tasks once, writes current', () => {
    const r = root()
    mkdirSync(join(r, 'tasks', 'cards'), { recursive: true })
    writeFileSync(join(r, 'tasks', 'config.json'), '{}')
    expect(migrateWorkspace(r)).toBe(true)
    expect(existsSync(join(r, 'tasks'))).toBe(false)
    expect(existsSync(join(r, 'projects', 'default', 'tasks', 'config.json'))).toBe(true)
    expect(readFileSync(join(r, 'current'), 'utf-8').trim()).toBe('default')
    expect(migrateWorkspace(r)).toBe(false) // second call: no-op
  })
  it('current defaults to default; writeCurrent validates existence', () => {
    const r = seeded()
    expect(currentProject(r)).toBe('default')
    expect(() => writeCurrent(r, 'nope')).toThrow(/unknown project "nope".*default/)
    createProject(r, 'house', now)
    writeCurrent(r, 'house')
    expect(currentProject(r)).toBe('house')
  })
  it('createProject scaffolds from default and validates', () => {
    const r = seeded()
    createProject(r, 'house', now)
    const t = projectTasksDir(r, 'house')
    for (const s of ['queue', 'cards', 'history', 'artifacts']) expect(existsSync(join(t, s))).toBe(true)
    expect(JSON.parse(readFileSync(join(t, 'config.json'), 'utf-8')).resolver.impl).toBe('x')
    expect(() => createProject(r, 'house', now)).toThrow(/already exists/)
    expect(() => createProject(r, 'Bad Name', now)).toThrow(/slug/)
    expect(() => createProject(r, 'x', now, 'ghost')).toThrow(/unknown template "ghost"/)
  })
  it('createProject from a template seeds cards with reset created/log', () => {
    const r = seeded()
    const tpl = join(r, 'templates', 'gtd', 'cards')
    mkdirSync(tpl, { recursive: true })
    writeCard(join(r, 'templates', 'gtd'), {
      shortname: 'capture-everything', title: 'Capture everything', status: 'inbox',
      created: '2020-01-01', links: [], labels: ['howto'], description: 'If it is on your mind, it goes here.', log: ['2020-01-01 00:00 — created']
    })
    expect(listTemplates(r)).toEqual(['gtd'])
    createProject(r, 'mine', now, 'gtd')
    const card = readCard(join(projectTasksDir(r, 'mine'), 'cards', 'capture-everything.md'))
    expect(card.created).toBe('2026-10-15')
    expect(card.labels).toEqual(['howto'])
    expect(card.log).toEqual(['2026-10-15 10:00 — created'])
  })
  it('trashProject moves (never deletes) and guards default', () => {
    const r = seeded()
    createProject(r, 'house', now)
    const trashed = trashProject(r, 'house', now)
    expect(existsSync(join(r, 'projects', 'house'))).toBe(false)
    expect(existsSync(trashed)).toBe(true)
    expect(trashed).toContain('.trash')
    expect(trashed).toContain('house')
    expect(() => trashProject(r, 'default', now)).toThrow(/default/)
    expect(() => trashProject(r, 'ghost', now)).toThrow(/unknown project/)
    expect(listProjects(r)).toEqual(['default'])
  })
})
```

Note: `writeCard(dir, card)` writes to `<dir>/cards/<shortname>.md` — the template helper call above relies on that existing behavior (check `files.ts` if in doubt).

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/__tests__/projects.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `src/main/tasks/projects.ts`** (shape; keep messages exactly as tested):

```ts
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, copyFileSync } from 'fs'
import { join } from 'path'
import { readCard, writeCard } from './files'

export const PROJECT_SLUG = /^[a-z0-9-]+$/
const stamp = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ')

export const projectTasksDir = (root: string, name: string): string =>
  join(root, 'projects', name, 'tasks')

export function migrateWorkspace(root: string): boolean {
  const legacy = join(root, 'tasks')
  const projects = join(root, 'projects')
  if (!existsSync(legacy) || existsSync(projects)) return false
  mkdirSync(join(projects, 'default'), { recursive: true })
  renameSync(legacy, projectTasksDir(root, 'default'))
  writeFileSync(join(root, 'current'), 'default\n')
  return true
}

export function listProjects(root: string): string[] {
  const dir = join(root, 'projects')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export function listTemplates(root: string): string[] {
  const dir = join(root, 'templates')
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

export function currentProject(root: string): string {
  const p = join(root, 'current')
  if (!existsSync(p)) return 'default'
  const name = readFileSync(p, 'utf-8').trim()
  return name || 'default'
}

export function writeCurrent(root: string, name: string): void {
  if (!listProjects(root).includes(name))
    throw new Error(`unknown project "${name}" — have: ${listProjects(root).join(', ')}`)
  writeFileSync(join(root, 'current'), `${name}\n`)
}

export function createProject(root: string, name: string, now: Date, template?: string): void {
  if (!PROJECT_SLUG.test(name)) throw new Error(`project name must be a slug ([a-z0-9-]): "${name}"`)
  if (listProjects(root).includes(name)) throw new Error(`project "${name}" already exists`)
  if (template && !listTemplates(root).includes(template))
    throw new Error(`unknown template "${template}" — have: ${listTemplates(root).join(', ') || 'none'}`)
  const tasks = projectTasksDir(root, name)
  for (const s of ['queue', 'cards', 'history', 'artifacts']) mkdirSync(join(tasks, s), { recursive: true })
  const tplDir = template ? join(root, 'templates', template) : undefined
  const defaults = projectTasksDir(root, 'default')
  for (const f of ['config.json', 'registry.json']) {
    const fromTpl = tplDir && existsSync(join(tplDir, f)) ? join(tplDir, f) : undefined
    const fromDefault = existsSync(join(defaults, f)) ? join(defaults, f) : undefined
    const src = fromTpl ?? fromDefault
    if (!src) throw new Error(`no default project to scaffold ${f} from`)
    copyFileSync(src, join(tasks, f))
  }
  if (tplDir && existsSync(join(tplDir, 'cards'))) {
    for (const f of readdirSync(join(tplDir, 'cards')).filter((n) => n.endsWith('.md'))) {
      const card = readCard(join(tplDir, 'cards', f))
      writeCard(tasks, {
        ...card,
        created: now.toISOString().slice(0, 10),
        log: [`${stamp(now)} — created`]
      })
    }
  }
}

export function trashProject(root: string, name: string, now: Date): string {
  if (name === 'default') throw new Error('the default project cannot be removed')
  if (!listProjects(root).includes(name))
    throw new Error(`unknown project "${name}" — have: ${listProjects(root).join(', ')}`)
  const trash = join(root, '.trash')
  mkdirSync(trash, { recursive: true })
  const dest = join(trash, `${now.toISOString().replace(/:/g, '-')}-${name}`)
  renameSync(join(root, 'projects', name), dest)
  return dest
}
```

- [ ] **Step 4: Full gate** — green (library is unused elsewhere yet).
- [ ] **Step 5: Commit** — `feat: project fs library — migrate, list, create-from-template, trash`

---

### Task 2: `project` CLI verb

**Files:**
- Modify: `src/main/tasks/cli.ts`
- Test: `src/main/__tests__/cli.test.ts`

**Interfaces:**
- Produces (consumed by Task 3):
  ```ts
  export type ProjectOp =
    | { op: 'list' }
    | { op: 'switch'; name: string }
    | { op: 'new'; name: string; template?: string }
    | { op: 'rm'; name: string }
  // CliResult gains:
  | { kind: 'project'; project: ProjectOp }
  ```
- Grammar (first token `project` or `projects`): `projects` | `project` → list; `project <slug>` → switch; `project new <slug>` (+ `--template <t>` or trailing `from <t>`) → new; `project rm <slug>` → rm. Bad slug, missing name, or trailing junk → `{ kind: 'error' }` (fork is final). Known limitation until Task 3: the ENGINE treats the new kind as unhandled; only parseCommand is under test here.

- [ ] **Step 1: Failing tests** — append a describe block to `cli.test.ts`:

```ts
describe('parseCommand — project verb', () => {
  it('project / projects list', () => {
    expect(parseCommand('projects', deps)).toEqual({ kind: 'project', project: { op: 'list' } })
    expect(parseCommand('project', deps)).toEqual({ kind: 'project', project: { op: 'list' } })
  })
  it('project <slug> switches', () => {
    expect(parseCommand('project house-renovation', deps)).toEqual({
      kind: 'project', project: { op: 'switch', name: 'house-renovation' }
    })
  })
  it('project new with --template and `from` sugar', () => {
    expect(parseCommand('project new house --template renovation', deps)).toEqual({
      kind: 'project', project: { op: 'new', name: 'house', template: 'renovation' }
    })
    expect(parseCommand('project new house from renovation', deps)).toEqual({
      kind: 'project', project: { op: 'new', name: 'house', template: 'renovation' }
    })
    expect(parseCommand('project new house', deps)).toEqual({
      kind: 'project', project: { op: 'new', name: 'house' }
    })
  })
  it('project rm <slug>', () => {
    expect(parseCommand('project rm house', deps)).toEqual({
      kind: 'project', project: { op: 'rm', name: 'house' }
    })
  })
  it('fork is final: bad grammar parks loud', () => {
    expect(parseCommand('project New House', deps).kind).toBe('error')
    expect(parseCommand('project new', deps).kind).toBe('error')
    expect(parseCommand('project house extra junk', deps).kind).toBe('error')
    expect(parseCommand('/project rm', deps).kind).toBe('error')
  })
})
```

- [ ] **Step 2: Verify failure.**
- [ ] **Step 3: Implement** — in `parseCommand`, BEFORE verb resolution (it is not a card verb):

```ts
const SLUG = /^[a-z0-9-]+$/
if (tokens[0].toLowerCase() === 'project' || tokens[0].toLowerCase() === 'projects') {
  const t = tokens.slice(1)
  const bad = (msg: string): CliResult => ({ kind: 'error', error: msg })
  if (t.length === 0) return { kind: 'project', project: { op: 'list' } }
  if (t[0] === 'new') {
    if (!t[1]) return bad('project new needs a name — `project new <slug> [--template <t>]`')
    if (!SLUG.test(t[1])) return bad(`project name must be a slug ([a-z0-9-]): "${t[1]}"`)
    const rest = t.slice(2)
    if (rest.length === 0) return { kind: 'project', project: { op: 'new', name: t[1] } }
    if ((rest[0] === '--template' || rest[0] === 'from') && rest[1] && SLUG.test(rest[1]) && rest.length === 2)
      return { kind: 'project', project: { op: 'new', name: t[1], template: rest[1] } }
    return bad(`project new: cannot parse "${rest.join(' ')}"`)
  }
  if (t[0] === 'rm') {
    if (!t[1] || !SLUG.test(t[1]) || t.length > 2)
      return bad('project rm needs one project name — `project rm <slug>`')
    return { kind: 'project', project: { op: 'rm', name: t[1] } }
  }
  if (t.length === 1 && SLUG.test(t[0])) return { kind: 'project', project: { op: 'switch', name: t[0] } }
  return bad(`project: cannot parse "${t.join(' ')}"`)
}
```

Add the `ProjectOp` type + the new `CliResult` member next to the existing kinds.
- [ ] **Step 4: Full gate; Step 5: Commit** — `feat: project CLI verb — list/switch/new/rm with template sugar`

---

### Task 3: ProjectManager + engine routing + boot migration + `result` field

**Files:**
- Create: `src/main/project-manager.ts`
- Modify: `src/main/tasks/engine.ts`, `src/main/tasks/types.ts`, `src/main/tasks/files.ts`, `src/main/index.ts`, `workspace/tasks/registry.json` (adds `project`/`project_rm` — note: this file MOVES under `workspace/projects/default/` the first time the app boots after this task; edit wherever it lives)
- Test: `src/main/__tests__/engine.test.ts`, `src/main/__tests__/project-manager.test.ts`

**Interfaces:**
- `types.ts`:
  ```ts
  export interface ProjectOps {
    list(): string[]
    templates(): string[]
    current(): string
    switch(name: string): Promise<void>
    create(name: string, template?: string): Promise<void>
    remove(name: string): Promise<void>
  }
  // Instruction gains: result?: string  (listing/confirmation output shown in the drawer)
  ```
- `EngineDeps` gains `projects?: ProjectOps`. Engine pipeline, after the `parsed.kind === 'error'` branch:
  ```ts
  if (parsed.kind === 'project') {
    const ops = this.deps.projects
    if (!ops) {
      this.setStatus(path, { status: 'attention', error: 'project operations not available', ...this.telemetry(path, 'cli') })
      return
    }
    const p = parsed.project
    try {
      if (p.op === 'list') {
        const cur = ops.current()
        const lines = ops.list().map((n) => (n === cur ? `* ${n}` : `  ${n}`))
        const tpl = ops.templates()
        this.setStatus(path, {
          status: 'done', via: 'cli', action: 'project',
          result: lines.join('\n') + (tpl.length ? `\ntemplates: ${tpl.join(', ')}` : ''),
          ...this.telemetry(path, 'cli')
        })
      } else if (p.op === 'switch') {
        await ops.switch(p.name)
        this.setStatus(path, { status: 'done', via: 'cli', action: 'project', result: `→ ${p.name}`, ...this.telemetry(path, 'cli') })
      } else if (p.op === 'new') {
        await ops.create(p.name, p.template)
        await ops.switch(p.name)
        this.setStatus(path, { status: 'done', via: 'cli', action: 'project', result: `created ${p.name}${p.template ? ` from ${p.template}` : ''} →`, ...this.telemetry(path, 'cli') })
      } else {
        // rm: destructive — park at the existing confirmation gate
        const id = path.split('/').pop()!.replace(/\.md$/, '')
        this.setStatus(path, { status: 'needs_confirmation', via: 'cli', action: 'project_rm', title: p.name, ...this.telemetry(path, 'cli') })
        const timer = setTimeout(() => this.reject(id), config.confirmation_timeout_s * 1000)
        this.pendingConfirm.set(id, { action: 'project_rm', card: undefined, status: p.name, timer })
      }
    } catch (err) {
      this.setStatus(path, { status: 'attention', error: err instanceof Error ? err.message : String(err), ...this.telemetry(path, 'cli') })
    }
    return
  }
  ```
  And in `confirm()`, BEFORE the normal execute path:
  ```ts
  if (pending.action === 'project_rm') {
    const name = pending.status! // carried the project name
    try {
      await this.deps.projects!.remove(name)
      this.setStatus(path, { status: 'done', result: `removed ${name} (recoverable in workspace/.trash)`, ...this.telemetry(path, 'cli') })
    } catch (err) {
      this.setStatus(path, { status: 'attention', error: err instanceof Error ? err.message : String(err), ...this.telemetry(path, 'cli') })
    }
    return
  }
  ```
- `files.ts`: add `result: data.result ?? undefined,` to `readInstruction`; `'result'` to `patchInstruction`'s Pick union; `via` handling unchanged.
- `project-manager.ts`:
  ```ts
  import { watch, type FSWatcher } from 'chokidar'
  import { join } from 'path'
  import { Engine } from './tasks/engine'
  import { loadConfig } from './tasks/config'
  import { loadRegistry } from './tasks/registry'
  import { bindCapabilities } from './capabilities/bind'
  import {
    migrateWorkspace, listProjects, listTemplates, currentProject, writeCurrent,
    projectTasksDir, createProject, trashProject
  } from './tasks/projects'
  import type { ProjectOps, TaskdeckConfig } from './tasks/types'

  export class ProjectManager implements ProjectOps {
    private engine!: Engine
    private cfg!: TaskdeckConfig
    private name!: string
    private watcher?: FSWatcher
    private onChange: () => void
    constructor(private root: string, onChange: () => void) { this.onChange = onChange }

    async boot(): Promise<void> {
      migrateWorkspace(this.root)
      await this.bind(currentProject(this.root))
      // Hand edits / git pulls to `current` are first-class switches.
      this.watcher = watch(join(this.root, 'current'), { ignoreInitial: true })
      this.watcher.on('change', () => {
        const want = currentProject(this.root)
        if (want !== this.name) void this.switch(want).catch((err) => console.error('project switch:', err))
      })
    }
    private async bind(name: string): Promise<void> {
      const tasksDir = projectTasksDir(this.root, name)
      const config = loadConfig(tasksDir)          // throws → caller parks the switch; old engine still running
      const { registry, aliases } = loadRegistry(tasksDir)
      const caps = bindCapabilities(config)
      const next = new Engine({ tasksDir, registry, config, caps, aliases, onChange: this.onChange, projects: this })
      if (this.engine) await this.engine.stop()
      this.engine = next
      this.cfg = config
      this.name = name
      next.start()
      this.onChange()
    }
    // ProjectOps
    list(): string[] { return listProjects(this.root) }
    templates(): string[] { return listTemplates(this.root) }
    current(): string { return this.name }
    async switch(name: string): Promise<void> {
      if (name === this.name) return
      await this.bind(name)              // bind first — a broken project must not half-switch
      writeCurrent(this.root, name)
    }
    async create(name: string, template?: string): Promise<void> { createProject(this.root, name, new Date(), template) }
    async remove(name: string): Promise<void> {
      if (name === this.name) await this.switch('default')
      trashProject(this.root, name, new Date())
      this.onChange()
    }
    // accessors for the server (Task 4)
    getEngine(): Engine { return this.engine }
    getTasksDir(): string { return projectTasksDir(this.root, this.name) }
    getUi(): TaskdeckConfig['ui'] { return this.cfg.ui }
    async stop(): Promise<void> { await this.watcher?.close(); await this.engine.stop() }
  }
  ```
  Note `switch()` binds before `writeCurrent` so a failing project parks without changing `current`; the file watcher ignores the subsequent self-write because `want === this.name`.
- `index.ts` boot: replace the `resolveTasksDir`/`loadConfig`/`loadRegistry`/`bindCapabilities`/`new Engine` block with `const root = resolveRoot(appRoot)` (from Task 1 — env var, then `~/.config/snarky-task/root` pointer file, then `<appRoot>/workspace`), `const pm = new ProjectManager(root, () => broadcastFn())`, `await pm.boot()`. `resolveTasksDir` in `config.ts` is deleted (grep its callers). Server opts change lands in Task 4 — in THIS task pass `tasksDir: pm.getTasksDir(), engine: pm.getEngine()` (still static; Task 4 makes them live accessors). `engine.start()` call at the end of boot is gone (ProjectManager starts it).
- Registry data: add to the live registry.json (wherever it resides post-migration) and to the engine-test fixture registry: `"project": { "class": "meta" }, "project_rm": { "class": "destructive" }`.

- [ ] **Step 1: Failing engine tests** (engine suite; the harness gains an optional fake ProjectOps on `setup`):

```ts
function fakeProjects(): ProjectOps & { switched: string[]; removed: string[] } {
  const state = { cur: 'default', switched: [] as string[], removed: [] as string[] }
  return {
    switched: state.switched, removed: state.removed,
    list: () => ['default', 'house'], templates: () => ['gtd'],
    current: () => state.cur,
    switch: async (n) => { state.cur = n; state.switched.push(n) },
    create: async () => {}, remove: async (n) => { state.removed.push(n) }
  }
}
it('projects lists into result, via cli', async () => {
  const projects = fakeProjects()
  const { tasksDir, engine } = setup([], projects)   // setup gains optional projects param → EngineDeps.projects
  const id = writeInstruction(tasksDir, 'projects', new Date('2026-10-02T10:00:00'))
  await engine.processFile(qpath(tasksDir, id))
  const inst = readInstruction(qpath(tasksDir, id))
  expect(inst.status).toBe('done')
  expect(inst.result).toContain('* default')
  expect(inst.result).toContain('house')
  expect(inst.result).toContain('templates: gtd')
})
it('project <name> switches', async () => {
  const projects = fakeProjects()
  const { tasksDir, engine } = setup([], projects)
  const id = writeInstruction(tasksDir, 'project house', new Date('2026-10-02T10:00:00'))
  await engine.processFile(qpath(tasksDir, id))
  expect(projects.switched).toEqual(['house'])
  expect(readInstruction(qpath(tasksDir, id)).result).toBe('→ house')
})
it('project rm parks at confirmation; confirm removes; reject does not', async () => {
  const projects = fakeProjects()
  const { tasksDir, engine } = setup([], projects)
  const id = writeInstruction(tasksDir, 'project rm house', new Date('2026-10-02T10:00:00'))
  await engine.processFile(qpath(tasksDir, id))
  expect(readInstruction(qpath(tasksDir, id)).status).toBe('needs_confirmation')
  await engine.confirm(id)
  expect(projects.removed).toEqual(['house'])
  expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
})
it('a failing project op parks with the real error', async () => {
  const projects = fakeProjects()
  projects.switch = async () => { throw new Error('unknown project "ghost" — have: default, house') }
  const { tasksDir, engine } = setup([], projects)
  const id = writeInstruction(tasksDir, 'project ghost', new Date('2026-10-02T10:00:00'))
  await engine.processFile(qpath(tasksDir, id))
  const inst = readInstruction(qpath(tasksDir, id))
  expect(inst.status).toBe('attention')
  expect(inst.error).toMatch(/unknown project "ghost"/)
})
```

- [ ] **Step 2: Failing ProjectManager test** — `src/main/__tests__/project-manager.test.ts`: build a root with a default project whose config binds the trivial test capabilities (`resolver: { impl: 'ollama', host: 'http://127.0.0.1:1', model: 'x' }` loads lazily — check `bindCapabilities` for the cheapest impl that constructs offline; `dates: { impl: 'chrono' }`, `thresholds: { card: 0.6 }`, `jobs: { max_parallel: 1 }`, `confirmation_timeout_s: 1`), plus registry with create/clean + project entries. Assert: `boot()` migrates a legacy `root/tasks` layout; an instruction written via `writeInstruction(pm.getTasksDir(), 'hello world', …)` + `processFile` lands a card in `projects/default/tasks/cards`; `await pm.switch('house')` (after `createProject`) re-points `getTasksDir()` and a new instruction lands in the house project; `pm.stop()` closes cleanly.
- [ ] **Step 3: Verify failures; Step 4: implement** per the interfaces above. **Step 5: Full gate** (watch: engine test `setup` signature change ripples — update all call sites mechanically). **Step 6: Commit** — `feat: ProjectManager — the switch is a file; project ops routed through the engine`

---

### Task 4: Server accessors + project info in snapshots

**Files:**
- Modify: `src/main/server.ts`, `src/main/index.ts`, `src/main/tasks/types.ts`
- Test: `src/main/__tests__/server.test.ts`

**Interfaces:**
- `ServerOptions` becomes accessor-based: `{ tasksDir(): string; engine(): Engine; ui(): TaskdeckConfig['ui']; project(): { current: string; list: string[]; templates: string[] }; surfacesDir: string; screenshot: () => Promise<string> }`. Every closure use of `tasksDir`/`engine`/`ui` inside server.ts becomes a call. `index.ts` passes arrows into the ProjectManager.
- `Snapshot` type gains `project?: { current: string; list: string[]; templates: string[] }`; the snapshot/SSE payloads merge `{ ...readSnapshot(tasksDir()), ui: ui(), project: project() }` (three places: SSE seed, broadcast, `/api/state` — grep `readSnapshot(` in server.ts).

- [ ] **Step 1: Failing test** — in server.test.ts, the existing harness constructs `startServer` opts; convert the fixture to accessors and add:
```ts
it('snapshot carries project info', async () => {
  const res = await fetch(`${base}/api/state`)
  const snap = await res.json()
  expect(snap.project).toEqual({ current: 'default', list: ['default'], templates: [] })
})
```
(fixture `project: () => ({ current: 'default', list: ['default'], templates: [] })`).
- [ ] **Step 2–4: red → implement → gate.** Mechanical but wide — take care with the SSE broadcast closure. **Step 5: Commit** — `feat: server reads tasksDir/engine/ui through accessors; snapshots carry project info`

---

### Task 5: Surfaces — topbar switcher, feed autocomplete, drawer result

**Files:**
- Modify: `surfaces/board/board.js`, `surfaces/board/board.css`, `surfaces/feed/feed.js`, `surfaces/feed/feed.css`

No test harness (manual QA at the end). All changes declarative: render from `state.snapshot.project`.

- [ ] **Step 1: Board topbar switcher** — in `renderTopbar()`, prepend a project chip before the tabs; a `state.projectMenu` boolean renders the dropdown in-flow:
```js
function renderTopbar() {
  const proj = state.snapshot.project
  const chip = proj
    ? `<div class="proj-wrap"><button class="proj-chip" data-proj-toggle>${esc(proj.current)} ▾</button>` +
      (state.projectMenu
        ? `<div class="proj-menu">` +
          proj.list.map((n) =>
            `<button class="proj-item${n === proj.current ? ' on' : ''}" data-proj="${esc(n)}">${esc(n)}</button>`
          ).join('') + `</div>`
        : '') + `</div>`
    : ''
  return `<nav class="topbar" aria-label="View modes">` + chip + TABS.map(/* unchanged */).join('') + `</nav>`
}
```
Delegated clicks (inside the existing root click listener, before the tab branch): `[data-proj-toggle]` → `patch({ projectMenu: !state.projectMenu })`; `[data-proj]` → `emitInstruction('project ' + name, {})`… **no** — project instructions are CLI-parsed, so emit the bare text with NO pre-resolved fields: `emitInstruction(\`project ${name}\`)` then `patch({ projectMenu: false })`. Any other click closes the menu. Add `projectMenu: false` to the store. CSS (board.css, near .topbar): `.proj-chip` mono like `.tab`; `.proj-wrap { position: relative }`; `.proj-menu { position: absolute; top: 34px; left: 8px; background: var(--card); border: var(--border-float); box-shadow: var(--shadow-float); border-radius: var(--radius); padding: 4px; z-index: 10; display: flex; flex-direction: column; }`; `.proj-item { text-align: left; padding: 5px 10px; font: var(--mono); background: none; border: none; cursor: pointer; color: var(--ink-2); } .proj-item:hover { color: var(--ink); background: rgba(15,15,12,.04); } .proj-item.on { color: var(--accent); }`.
- [ ] **Step 2: Feed autocomplete** — in feed.js, extend the completion trigger: when the input starts with `project ` (or `/project `), offer `new`, `rm`, project names, and (after `new <name> from `) template names from `lastSnapshot.project` — follow the shape of the existing `AC_VERBS`/`#`-completion code; insert plain words. Add `/project` + `/projects` entries to `AC_VERBS` (hints: `switch/new/rm — decks per concern`, `list projects`).
- [ ] **Step 3: Drawer result** — in `drawerHtml`, after the error row: `${i.result ? kv('result', `<span class="result-v">${esc(i.result)}</span>`, ' wide') : ''}` and feed.css: `.result-v { white-space: pre-wrap; font: var(--mono); }`.
- [ ] **Step 4: eslint surfaces + full gate. Step 5: Commit** — `feat: project switcher in the topbar; project autocomplete; drawer shows op results`

---

### Task 6: Starter templates, gitignore, docs

**Files:**
- Create: `workspace/templates/gtd/cards/*.md`, `workspace/templates/renovation/cards/*.md`, `workspace/templates/business-canvas/cards/*.md`
- Modify: `.gitignore`, `CLAUDE.md`

- [ ] **Step 1: Templates.** Card file format = exactly what `writeCard` produces; author one file like this (frontmatter keys: title, status, created, links, labels, description — body `## Log` list):

```markdown
---
title: Capture everything
status: inbox
created: '2026-10-15'
links: []
labels: [howto]
description: If it is on your mind, it goes here. Type a thought in the console — no verb needed.
---

## Log
- 2026-10-15 00:00 — created
```

Decks (status `inbox` unless noted; keep descriptions one or two sentences, practical tone):
  - **gtd** (4): `capture-everything` (above); `clarify-weekly` ("Walk the inbox weekly: promote, backlog, or drop."); `next-actions` (status `active`, "Keep 3–5 cards active, no more."); `someday-maybe` (status `waiting`, labels `[someday]`).
  - **renovation** (6): `define-scope-and-budget` (active), `permits-and-approvals`, `demolition`, `rough-in-trades` ("Electrical, plumbing, HVAC — sequence before closing walls."), `finishes` ("Floors, paint, fixtures."), `punch-list` (waiting, "Walkthrough of every defect before sign-off.").
  - **business-canvas** (9, one per block, labels `[canvas]`): `customer-segments`, `value-proposition` (active), `channels`, `customer-relationships`, `revenue-streams`, `key-resources`, `key-activities`, `key-partners`, `cost-structure` — description = the canonical one-line question for each block (e.g. value-proposition: "What pain do we kill, what gain do we create, and for whom?").
- [ ] **Step 2: Gitignore rework** — replace the `workspace/tasks/*` block with:
```
workspace/projects/
workspace/current
workspace/.trash/
!workspace/templates/
```
(templates tracked; all live project data ignored; delete the old four `workspace/tasks/...` lines and the `.gitkeep` exceptions — also `git rm --cached` anything from `workspace/tasks` still tracked, e.g. config.json/registry.json/.gitkeeps, and instead commit `workspace/templates/`). **Think before deleting:** the tracked `config.json`/`registry.json` were the fresh-clone scaffold; a fresh clone now needs one — add `workspace/templates/default/config.json` + `registry.json` (copies of the current live ones, ollama defaults) and make `projects.ts createProject`'s default-fallback ALSO try `templates/default/` when `projects/default` lacks them; `migrateWorkspace` on a fresh clone (no `workspace/tasks` at all) must bootstrap `projects/default` by scaffolding from `templates/default` (add this to `migrateWorkspace` + a test: empty root with only templates → boot yields a working default project).
- [ ] **Step 3: CLAUDE.md** — rewrite the Data layout section for the new tree; add a Projects paragraph (verbs, the `current` file, trash semantics, templates-as-folders) and document the working-directory resolution: `XWEB_WORKSPACE` env → `~/.config/snarky-task/root` pointer file (one line, any path — point it at a Syncthing or git-synced folder) → `./workspace`.
- [ ] **Step 4: Full gate + manual QA list in the commit body:** restart app → old deck appears (migration) → `projects` lists → `project new house from renovation` seeds and switches → board chip switches back → `project rm house` confirms then trashes → hand-edit `workspace/current` and watch the board flip.
- [ ] **Step 5: Commit** — `feat: starter templates (gtd, renovation, business-canvas); workspace layout gitignore; docs`

---

## Self-review (done at plan time)

- **Spec coverage:** model/migration → T1+T3; verbs → T2+T3; ProjectManager/watcher/no-fallbacks switch → T3; surfaces + result field → T4+T5 (result read/patch in T3); templates/gitignore/docs + fresh-clone bootstrap → T6; sharing section needs no code.
- **Type consistency:** `ProjectOps` defined once in types.ts (T3), consumed by engine deps, ProjectManager, test fakes; CLI `ProjectOp` (T2) is the parse-side shape consumed by the engine branch (T3); server accessor names (T4) match ProjectManager getters via arrows in index.ts.
- **Known sequencing quirks (deliberate):** between T2 and T3 the engine captures `project …` input as a card (parse kind unhandled) — tests don't exercise it; T3 edits registry.json at its *current* path and notes it migrates at first boot; T6 hardens fresh-clone bootstrap discovered during gitignore rework.
