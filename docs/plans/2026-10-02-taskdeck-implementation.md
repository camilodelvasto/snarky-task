# Taskdeck Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the xweb shell into taskdeck — a local, file-based, text-controlled task manager where a registry/resolver engine parses utterances into cards, per the spec.

**Architecture:** Files under `workspace/tasks/` are the only state. An engine module in the Electron main process watches the queue, resolves each utterance against a declarative registry using swappable capability modules (Laya resolver, chrono dates, Ollama generator, `claude -p` agent), and writes card files. One stateless HTTP API on :7920 translates between clients and files; two vanilla web surfaces (feed, board) render SSE snapshots inside two WebContentsViews.

**Tech Stack:** Electron + electron-vite + TypeScript + vitest (existing); add `chokidar`, `gray-matter`, `chrono-node`; later `@receptron/laya` + `onnxruntime-node`. Remove `node-pty`, `@xterm/*`, `better-sqlite3`, `react`, `react-dom`.

**Spec:** `docs/specs/2026-10-02-taskdeck-design.md` — read it first; every task argues from it.

## Global Constraints

- **No fallbacks.** A missing or failing binding throws (startup) or sets `attention` with the real error (runtime). Never silently default. (spec: Principles)
- **Instruction bodies are verbatim.** The engine only writes frontmatter on queue files; the raw utterance is never rewritten.
- **The engine holds no state that isn't derivable from files.** In-memory structures are caches/locks only.
- **Surfaces are dumb.** No client state beyond the DOM; render snapshots, POST actions. No frameworks.
- **Contracts, not logic.** Capabilities are only used through the interfaces in `src/main/capabilities/contracts.ts`.
- Card statuses: `inbox | active | waiting | done | dropped`. Instruction statuses: `queued | working | needs_confirmation | attention | done`. Exact strings, everywhere.
- Run `npm run typecheck && npx eslint . && npx vitest run` before every commit.

## File Structure

```
src/main/
  index.ts                     # boot: window, views, server+engine (modify)
  views.ts                     # two fixed WebContentsViews (feed|board) + screenshot (create)
  ipc-handlers.ts              # slim: bounds for two regions (rewrite)
  screenshot-cleanup.ts        # keep as-is
  server.ts                    # HTTP on 7920: /api/*, static surfaces, MCP (rewrite of mcp/server.ts)
  tasks/
    types.ts                   # Instruction, Card, Snapshot, Registry types
    files.ts                   # frontmatter IO, slugs, instruction/card read-write
    snapshot.ts                # derive Snapshot from tasks/ dir
    config.ts                  # load+validate config.json (throw on bad)
    registry.ts                # load+validate registry.json
    prepass.ts                 # meta-commands, #refs, dates
    candidates.ts              # keyword-overlap card candidate selection
    resolve.ts                 # resolver orchestration + thresholds
    handlers.ts                # create/update_status/note/link/delete handlers
    engine.ts                  # pipeline, per-card FIFO, attention freeze, confirmation
    jobs.ts                    # delegation pool
  capabilities/
    contracts.ts               # Resolver, Dates, Generator, Agent interfaces
    chrono-dates.ts
    ollama-generator.ts
    ollama-resolver.ts         # Resolver via Ollama JSON-constrained choice
    laya-resolver.ts           # Resolver via Laya ONNX
    claude-agent.ts
    bind.ts                    # config → Capabilities instance
surfaces/
  feed/index.html  feed/feed.css  feed/feed.js
  board/index.html board/board.css board/board.js
workspace/tasks/
  config.json  registry.json  queue/.gitkeep  cards/.gitkeep  artifacts/.gitkeep
src/renderer/                  # sliver: divider + bounds reporting (rewrite)
src/preload/index.ts           # sliver (rewrite)
```

---

### Task 1: Strip the shell

**Files:**
- Delete: `src/main/persona/` (all), `src/main/pty.ts`, `src/main/mcp/` (all), `src/main/pane-manager.ts`, `src/main/browser-views.ts`, `src/main/__tests__/persona-capture.test.ts`, `src/main/__tests__/persona-pages.test.ts`, `src/main/__tests__/intent-resolver.test.ts`, `src/main/__tests__/pane-manager.test.ts`, `src/renderer/src/components/` (all), `projects/landing-site/`, `templates/astro/`, `.mcp.json` (root — the new tool surface is registered later)
- Modify: `package.json`, `electron.vite.config.ts`, `eslint.config.mjs`, `src/shared/types.ts`, `src/main/index.ts`, `src/main/ipc-handlers.ts`, `src/preload/index.ts`, `src/renderer/`

**Interfaces:**
- Produces: an app that boots to an empty window; `src/shared/types.ts` containing only `ContentBounds` and new `IPC` constants `REGIONS` (`'layout:regions'`); `screenshot-cleanup.ts` + its test untouched.

- [ ] **Step 1: Remove dependencies and dead config**

```bash
npm rm node-pty @xterm/xterm @xterm/addon-fit @xterm/addon-web-links better-sqlite3 @types/better-sqlite3 react react-dom @types/react @types/react-dom @vitejs/plugin-react eslint-plugin-react eslint-plugin-react-hooks eslint-plugin-react-refresh highlight.js
```

In `package.json` scripts, change postinstall to `"postinstall": "electron-builder install-app-deps"` and delete `scripts/setup-projects.mjs`. In `electron.vite.config.ts` remove the react plugin import/usage. In `eslint.config.mjs` remove the three react plugin imports, their config entries, and the react settings block (keep prettier + ts + ignores).

- [ ] **Step 2: Delete the files listed above**

```bash
git rm -r src/main/persona src/main/mcp src/main/pty.ts src/main/pane-manager.ts src/main/browser-views.ts src/renderer/src/components projects/landing-site templates/astro .mcp.json
git rm src/main/__tests__/persona-capture.test.ts src/main/__tests__/persona-pages.test.ts src/main/__tests__/intent-resolver.test.ts src/main/__tests__/pane-manager.test.ts
```

- [ ] **Step 3: Rewrite the survivors to a booting skeleton**

`src/shared/types.ts` becomes:

```ts
export interface ContentBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutRegions {
  feed: ContentBounds
  board: ContentBounds
}

export const IPC = {
  REGIONS: 'layout:regions'
} as const
```

`src/main/index.ts` becomes (single-instance lock and teardown guards survive from the old file):

```ts
import { app, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { setupIpcHandlers } from './ipc-handlers'
import { ScreenshotCleaner, SCREENSHOT_DIR } from './screenshot-cleanup'

let mainWindow: BrowserWindow | null = null
const screenshotCleaner = new ScreenshotCleaner(SCREENSHOT_DIR)

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0f0f1a',
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })

  setupIpcHandlers(mainWindow)
  screenshotCleaner.start()

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
    screenshotCleaner.stop()
  })
}

if (!app.requestSingleInstanceLock()) {
  dialog.showErrorBox('taskdeck is already running', 'Quit the running instance (Cmd+Q) first.')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  app.whenReady().then(createWindow)
}

app.on('window-all-closed', () => {
  app.quit()
})
```

`src/main/ipc-handlers.ts` becomes:

```ts
import { BrowserWindow } from 'electron'

export function setupIpcHandlers(_window: BrowserWindow): void {
  // regions wiring arrives with views.ts (Task 13)
}
```

`src/preload/index.ts` becomes:

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { IPC, LayoutRegions } from '../shared/types'

const api = {
  sendRegions: (regions: LayoutRegions): void => {
    ipcRenderer.send(IPC.REGIONS, regions)
  }
}

export type TaskdeckAPI = typeof api
contextBridge.exposeInMainWorld('taskdeck', api)
```

Replace `src/preload/index.d.ts` to declare `window.taskdeck: TaskdeckAPI`. Replace `src/renderer/src/` contents with `main.ts` (empty placeholder: `export {}`) and make `src/renderer/index.html` a bare dark page importing it; delete `App.tsx`, `env.d.ts` react refs, styles.

- [ ] **Step 4: Verify the skeleton**

Run: `npm install && npm run typecheck && npx eslint . && npx vitest run`
Expected: all pass; only `screenshot-cleanup.test.ts` runs. Then `npm run dev` briefly: an empty dark window opens, no crash on quit.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "chore: strip shell to skeleton for taskdeck (remove persona, pty/xterm, react, old MCP)"
```

---

### Task 2: Types, workspace seeds, config + registry loaders

**Files:**
- Create: `src/main/tasks/types.ts`, `src/main/tasks/config.ts`, `src/main/tasks/registry.ts`, `workspace/tasks/config.json`, `workspace/tasks/registry.json`, `workspace/tasks/queue/.gitkeep`, `workspace/tasks/cards/.gitkeep`, `workspace/tasks/artifacts/.gitkeep`
- Test: `src/main/__tests__/config-registry.test.ts`

**Interfaces:**
- Produces: `loadConfig(tasksDir: string): TaskdeckConfig` (throws on missing file/field), `loadRegistry(tasksDir: string): Registry` (throws on invalid class), all types below. `resolveTasksDir(appRoot: string): string` → `$XWEB_WORKSPACE/tasks` or `<appRoot>/workspace/tasks` (throws if dir missing).

- [ ] **Step 1: Write `src/main/tasks/types.ts`**

```ts
export type InstructionStatus = 'queued' | 'working' | 'needs_confirmation' | 'attention' | 'done'
export type CardStatus = 'inbox' | 'active' | 'waiting' | 'done' | 'dropped'
export const CARD_STATUSES: CardStatus[] = ['inbox', 'active', 'waiting', 'done', 'dropped']

export interface Instruction {
  id: string // filename without .md
  path: string
  status: InstructionStatus
  action?: string
  card?: string
  error?: string
  raw: string
}

export interface Card {
  shortname: string
  path: string
  title: string
  status: CardStatus
  created: string // YYYY-MM-DD
  due?: string
  links: string[]
  labels: string[]
  description: string
  log: string[]
}

export interface Snapshot {
  instructions: Instruction[]
  cards: Card[]
}

export type OperationClass = 'normal' | 'destructive' | 'meta'
export interface RegistryEntry {
  class: OperationClass
  params?: Record<string, string[]>
}
export type Registry = Record<string, RegistryEntry>

export interface TaskdeckConfig {
  resolver: { impl: string; [k: string]: unknown }
  dates: { impl: string }
  generator?: { impl: string; host: string; model: string }
  agent?: { impl: string; enabled: boolean }
  thresholds: { action: number; card: number; status: number }
  jobs: { max_parallel: number }
  confirmation_timeout_s: number
}
```

- [ ] **Step 2: Write seed files**

`workspace/tasks/registry.json`:

```json
{
  "create": { "class": "normal" },
  "update_status": { "class": "normal", "params": { "status": ["inbox", "active", "waiting", "done", "dropped"] } },
  "note": { "class": "normal" },
  "link": { "class": "normal" },
  "delete": { "class": "destructive" },
  "delegate": { "class": "normal", "params": { "executor": ["generator", "agent"] } },
  "clean": { "class": "meta" }
}
```

`workspace/tasks/config.json`:

```json
{
  "resolver": { "impl": "ollama", "host": "http://127.0.0.1:11434", "model": "qwen3:4b" },
  "dates": { "impl": "chrono" },
  "generator": { "impl": "ollama", "host": "http://127.0.0.1:11434", "model": "qwen3:4b" },
  "agent": { "impl": "claude-cli", "enabled": true },
  "thresholds": { "action": 0.65, "card": 0.6, "status": 0.6 },
  "jobs": { "max_parallel": 3 },
  "confirmation_timeout_s": 300
}
```

(Resolver seeded to `ollama`; flip to `laya` after Task 12 downloads a checkpoint. A seed is a declared binding, not a fallback.) Add empty `.gitkeep` files in `queue/`, `cards/`, `artifacts/`. Add `workspace/tasks/queue/*.md`, `workspace/tasks/cards/*.md`, `workspace/tasks/artifacts/` to `.gitignore` (state is yours, not the repo's).

- [ ] **Step 3: Write the failing tests**

`src/main/__tests__/config-registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadConfig } from '../tasks/config'
import { loadRegistry } from '../tasks/registry'

function tasksDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'td-'))
  mkdirSync(join(dir, 'tasks'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, 'tasks', name), content)
  }
  return join(dir, 'tasks')
}

const GOOD_CONFIG = JSON.stringify({
  resolver: { impl: 'ollama', host: 'http://127.0.0.1:11434', model: 'm' },
  dates: { impl: 'chrono' },
  thresholds: { action: 0.65, card: 0.6, status: 0.6 },
  jobs: { max_parallel: 3 },
  confirmation_timeout_s: 300
})

describe('loadConfig', () => {
  it('loads a valid config', () => {
    const dir = tasksDir({ 'config.json': GOOD_CONFIG })
    expect(loadConfig(dir).resolver.impl).toBe('ollama')
  })
  it('throws when the file is missing', () => {
    const dir = tasksDir({})
    expect(() => loadConfig(dir)).toThrow(/config\.json/)
  })
  it('throws when a required field is missing — no silent defaults', () => {
    const bad = JSON.parse(GOOD_CONFIG)
    delete bad.thresholds
    const dir = tasksDir({ 'config.json': JSON.stringify(bad) })
    expect(() => loadConfig(dir)).toThrow(/thresholds/)
  })
})

describe('loadRegistry', () => {
  it('loads valid registry keys', () => {
    const dir = tasksDir({ 'registry.json': JSON.stringify({ create: { class: 'normal' } }) })
    expect(loadRegistry(dir).create.class).toBe('normal')
  })
  it('throws on an unknown operation class', () => {
    const dir = tasksDir({ 'registry.json': JSON.stringify({ x: { class: 'spicy' } }) })
    expect(() => loadRegistry(dir)).toThrow(/spicy/)
  })
})
```

- [ ] **Step 4: Run tests, verify they fail** — `npx vitest run config-registry` → FAIL (modules missing).

- [ ] **Step 5: Implement `config.ts` and `registry.ts`**

```ts
// src/main/tasks/config.ts
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { TaskdeckConfig } from './types'

const REQUIRED: Array<keyof TaskdeckConfig> = [
  'resolver',
  'dates',
  'thresholds',
  'jobs',
  'confirmation_timeout_s'
]

export function loadConfig(tasksDir: string): TaskdeckConfig {
  const path = join(tasksDir, 'config.json')
  if (!existsSync(path)) throw new Error(`config.json not found at ${path}`)
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  for (const key of REQUIRED) {
    if (raw[key] === undefined) throw new Error(`config.json missing required field: ${key}`)
  }
  for (const t of ['action', 'card', 'status']) {
    if (typeof raw.thresholds[t] !== 'number')
      throw new Error(`config.json missing required field: thresholds.${t}`)
  }
  return raw as TaskdeckConfig
}

export function resolveTasksDir(appRoot: string): string {
  const base = process.env.XWEB_WORKSPACE || join(appRoot, 'workspace')
  const dir = join(base, 'tasks')
  if (!existsSync(dir)) throw new Error(`tasks workspace not found: ${dir}`)
  return dir
}
```

```ts
// src/main/tasks/registry.ts
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Registry } from './types'

const CLASSES = ['normal', 'destructive', 'meta']

export function loadRegistry(tasksDir: string): Registry {
  const path = join(tasksDir, 'registry.json')
  if (!existsSync(path)) throw new Error(`registry.json not found at ${path}`)
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Registry
  for (const [key, entry] of Object.entries(raw)) {
    if (!CLASSES.includes(entry.class))
      throw new Error(`registry entry "${key}" has unknown class "${entry.class}"`)
  }
  return raw
}
```

- [ ] **Step 6: Run tests, verify pass** — `npx vitest run config-registry` → PASS.
- [ ] **Step 7: Commit** — `git add -A && git commit -m "feat: taskdeck types, workspace seeds, config+registry loaders"`

---

### Task 3: File IO — instructions, cards, slugs

**Files:**
- Create: `src/main/tasks/files.ts`
- Test: `src/main/__tests__/files.test.ts`

**Interfaces:**
- Consumes: types from Task 2.
- Produces:
  - `slugify(title: string, taken: Set<string>): string` — lowercase-hyphen slug, `-2`/`-3`… on collision
  - `writeInstruction(tasksDir: string, text: string, now: Date): string` — creates `queue/<stamp>-<rand>.md` with `status: queued`, returns id
  - `readInstruction(path: string): Instruction`
  - `patchInstruction(path: string, patch: Partial<Pick<Instruction, 'status' | 'action' | 'card' | 'error'>>): void` — frontmatter-only; body untouched
  - `readCard(path: string): Card`
  - `writeCard(tasksDir: string, card: Omit<Card, 'path'>): string` — writes `cards/<shortname>.md`, returns path
  - `appendLog(cardPath: string, line: string): void`
  - Install: `npm i gray-matter`

- [ ] **Step 1: Write the failing tests**

```ts
// src/main/__tests__/files.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  slugify, writeInstruction, readInstruction, patchInstruction,
  writeCard, readCard, appendLog
} from '../tasks/files'

function freshTasksDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const d of ['queue', 'cards', 'artifacts']) mkdirSync(join(dir, d), { recursive: true })
  return dir
}

describe('slugify', () => {
  it('slugs and dedupes', () => {
    expect(slugify('Proposal for Y!', new Set())).toBe('proposal-for-y')
    expect(slugify('Proposal for Y', new Set(['proposal-for-y']))).toBe('proposal-for-y-2')
  })
})

describe('instruction files', () => {
  it('writes queued instruction with verbatim body and reads it back', () => {
    const dir = freshTasksDir()
    const id = writeInstruction(dir, 'gotta write the ngo proposal this wed', new Date('2026-10-02T10:12:33'))
    const inst = readInstruction(join(dir, 'queue', `${id}.md`))
    expect(inst.status).toBe('queued')
    expect(inst.raw).toBe('gotta write the ngo proposal this wed')
    expect(id).toMatch(/^2026-10-02T10-12-33/)
  })
  it('patches frontmatter without touching the body', () => {
    const dir = freshTasksDir()
    const id = writeInstruction(dir, 'raw text stays', new Date())
    const path = join(dir, 'queue', `${id}.md`)
    patchInstruction(path, { status: 'attention', error: 'resolver unavailable' })
    const inst = readInstruction(path)
    expect(inst.status).toBe('attention')
    expect(inst.error).toBe('resolver unavailable')
    expect(inst.raw).toBe('raw text stays')
  })
})

describe('card files', () => {
  it('round-trips a card and appends log lines', () => {
    const dir = freshTasksDir()
    const path = writeCard(dir, {
      shortname: 'proposal-y', title: 'Proposal for Y', status: 'inbox',
      created: '2026-10-02', links: [], labels: [], description: 'Funding proposal.', log: []
    })
    appendLog(path, '2026-10-02 10:12 — declined')
    const card = readCard(path)
    expect(card.title).toBe('Proposal for Y')
    expect(card.log).toEqual(['2026-10-02 10:12 — declined'])
    expect(readFileSync(path, 'utf-8')).toContain('## Log')
  })
})
```

- [ ] **Step 2: Run, verify FAIL** — `npx vitest run files` → module not found.
- [ ] **Step 3: Implement `files.ts`**

```ts
// src/main/tasks/files.ts
import matter from 'gray-matter'
import { readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'
import type { Card, Instruction } from './types'

export function slugify(title: string, taken: Set<string>): string {
  const base =
    title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'card'
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function writeInstruction(tasksDir: string, text: string, now: Date): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const id = `${stamp}-${randomBytes(2).toString('hex')}`
  const content = matter.stringify(`\n${text}\n`, { status: 'queued' })
  writeFileSync(join(tasksDir, 'queue', `${id}.md`), content)
  return id
}

export function readInstruction(path: string): Instruction {
  const { data, content } = matter(readFileSync(path, 'utf-8'))
  return {
    id: basename(path, '.md'),
    path,
    status: data.status,
    action: data.action ?? undefined,
    card: data.card ?? undefined,
    error: data.error ?? undefined,
    raw: content.trim()
  }
}

export function patchInstruction(
  path: string,
  patch: Partial<Pick<Instruction, 'status' | 'action' | 'card' | 'error'>>
): void {
  const { data, content } = matter(readFileSync(path, 'utf-8'))
  writeFileSync(path, matter.stringify(content, { ...data, ...patch }))
}

const LOG_HEADER = '## Log'

export function writeCard(tasksDir: string, card: Omit<Card, 'path'>): string {
  const path = join(tasksDir, 'cards', `${card.shortname}.md`)
  const front = {
    title: card.title,
    status: card.status,
    created: card.created,
    ...(card.due ? { due: card.due } : {}),
    links: card.links,
    labels: card.labels
  }
  const body = `\n${card.description}\n\n${LOG_HEADER}\n${card.log.map((l) => `- ${l}`).join('\n')}\n`
  writeFileSync(path, matter.stringify(body, front))
  return path
}

export function readCard(path: string): Card {
  const { data, content } = matter(readFileSync(path, 'utf-8'))
  const [desc, logPart] = content.split(LOG_HEADER)
  const log = (logPart ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2))
  return {
    shortname: basename(path, '.md'),
    path,
    title: data.title,
    status: data.status,
    created: String(data.created),
    due: data.due ? String(data.due) : undefined,
    links: data.links ?? [],
    labels: data.labels ?? [],
    description: desc.trim(),
    log
  }
}

export function appendLog(cardPath: string, line: string): void {
  appendFileSync(cardPath, `- ${line}\n`)
}
```

- [ ] **Step 4: Run, verify PASS** — `npx vitest run files`.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: taskdeck file IO (instructions, cards, slugs)"`

---

### Task 4: Snapshot derivation

**Files:**
- Create: `src/main/tasks/snapshot.ts`
- Test: `src/main/__tests__/snapshot.test.ts`

**Interfaces:**
- Consumes: `readInstruction`, `readCard` (Task 3).
- Produces: `readSnapshot(tasksDir: string): Snapshot` — instructions sorted by id ascending (filenames are time-ordered), cards sorted by `created` then shortname. Unparseable files are skipped with `console.error` (a hand-edit mid-save must not kill the engine; the file re-parses on next change).

- [ ] **Step 1: Failing test**

```ts
// src/main/__tests__/snapshot.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeInstruction, writeCard } from '../tasks/files'
import { readSnapshot } from '../tasks/snapshot'

it('derives a snapshot from files, skipping unparseable ones', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const d of ['queue', 'cards', 'artifacts']) mkdirSync(join(dir, d), { recursive: true })
  writeInstruction(dir, 'first', new Date('2026-10-02T10:00:00'))
  writeInstruction(dir, 'second', new Date('2026-10-02T11:00:00'))
  writeCard(dir, { shortname: 'a-card', title: 'A', status: 'inbox', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
  writeFileSync(join(dir, 'cards', 'broken.md'), '---\ntitle: [unclosed\n')
  const snap = readSnapshot(dir)
  expect(snap.instructions.map((i) => i.raw)).toEqual(['first', 'second'])
  expect(snap.cards.map((c) => c.shortname)).toEqual(['a-card'])
})
```

- [ ] **Step 2: Run, FAIL.** `npx vitest run snapshot`
- [ ] **Step 3: Implement**

```ts
// src/main/tasks/snapshot.ts
import { readdirSync } from 'fs'
import { join } from 'path'
import { readInstruction, readCard } from './files'
import type { Snapshot, Instruction, Card } from './types'

function collect<T>(dir: string, read: (p: string) => T): T[] {
  const out: T[] = []
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    try {
      out.push(read(join(dir, name)))
    } catch (err) {
      console.error(`snapshot: skipping unparseable ${name}:`, err)
    }
  }
  return out
}

export function readSnapshot(tasksDir: string): Snapshot {
  const instructions = collect<Instruction>(join(tasksDir, 'queue'), readInstruction)
  const cards = collect<Card>(join(tasksDir, 'cards'), readCard).sort(
    (a, b) => a.created.localeCompare(b.created) || a.shortname.localeCompare(b.shortname)
  )
  return { instructions, cards }
}
```

- [ ] **Step 4: Run, PASS.** **Step 5: Commit** — `git commit -am "feat: snapshot derivation from tasks dir"`

---

### Task 5: Capability contracts + chrono dates + binder

**Files:**
- Create: `src/main/capabilities/contracts.ts`, `src/main/capabilities/chrono-dates.ts`, `src/main/capabilities/bind.ts`
- Test: `src/main/__tests__/capabilities.test.ts`
- Install: `npm i chrono-node`

**Interfaces:**
- Produces:

```ts
// contracts.ts — exact content
export interface ChoiceOption { key: string; description: string }
export interface Choice { context: string; question: string; options: ChoiceOption[] }
export interface Resolver { decide(q: Choice): Promise<{ key: string; confidence: number }> }
export interface Dates { extract(text: string, now: Date): { due?: string; cleaned: string } }
export interface Generator { complete(prompt: string): Promise<string> }
export interface Agent { run(prompt: string, cwd: string): Promise<string> }
export interface Capabilities { resolver: Resolver; dates: Dates; generator?: Generator; agent?: Agent }
```

- `bindCapabilities(config: TaskdeckConfig): Capabilities` — maps `impl` strings to constructors (`chrono`→ChronoDates, `ollama`→OllamaResolver/OllamaGenerator, `laya`→LayaResolver, `claude-cli`→ClaudeAgent); **throws** `Unknown resolver impl "x"` on anything else. Generator/agent only bound if present in config (agent also requires `enabled: true`).

- [ ] **Step 1: Failing tests**

```ts
// src/main/__tests__/capabilities.test.ts
import { describe, it, expect } from 'vitest'
import { ChronoDates } from '../capabilities/chrono-dates'
import { bindCapabilities } from '../capabilities/bind'
import type { TaskdeckConfig } from '../tasks/types'

describe('ChronoDates', () => {
  const dates = new ChronoDates()
  const now = new Date('2026-10-02T10:00:00') // a Friday
  it('extracts "this wed" as the upcoming Wednesday and cleans the text', () => {
    const r = dates.extract('gotta write the ngo proposal this wed', now)
    expect(r.due).toBe('2026-10-07')
    expect(r.cleaned).toBe('gotta write the ngo proposal')
  })
  it('returns no due date when none is present', () => {
    const r = dates.extract('proposal for Y got declined', now)
    expect(r.due).toBeUndefined()
    expect(r.cleaned).toBe('proposal for Y got declined')
  })
})

describe('bindCapabilities', () => {
  const base: TaskdeckConfig = {
    resolver: { impl: 'ollama', host: 'http://x', model: 'm' },
    dates: { impl: 'chrono' },
    thresholds: { action: 0.65, card: 0.6, status: 0.6 },
    jobs: { max_parallel: 3 },
    confirmation_timeout_s: 300
  }
  it('throws on unknown impl — no fallback', () => {
    expect(() => bindCapabilities({ ...base, dates: { impl: 'vibes' } })).toThrow(/vibes/)
  })
  it('binds chrono dates and leaves generator/agent unbound when absent', () => {
    const caps = bindCapabilities(base)
    expect(caps.dates).toBeDefined()
    expect(caps.generator).toBeUndefined()
    expect(caps.agent).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement**

```ts
// src/main/capabilities/chrono-dates.ts
import * as chrono from 'chrono-node'
import type { Dates } from './contracts'

export class ChronoDates implements Dates {
  extract(text: string, now: Date): { due?: string; cleaned: string } {
    const results = chrono.parse(text, now, { forwardDate: true })
    if (results.length === 0) return { cleaned: text.trim() }
    const r = results[0]
    const d = r.start.date()
    const due = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const cleaned = (text.slice(0, r.index) + text.slice(r.index + r.text.length))
      .replace(/\s+/g, ' ')
      .trim()
    return { due, cleaned }
  }
}
```

```ts
// src/main/capabilities/bind.ts
import type { Capabilities } from './contracts'
import type { TaskdeckConfig } from '../tasks/types'
import { ChronoDates } from './chrono-dates'
import { OllamaResolver } from './ollama-resolver'
import { OllamaGenerator } from './ollama-generator'
import { LayaResolver } from './laya-resolver'
import { ClaudeAgent } from './claude-agent'

export function bindCapabilities(config: TaskdeckConfig): Capabilities {
  const caps: Partial<Capabilities> = {}

  switch (config.dates.impl) {
    case 'chrono':
      caps.dates = new ChronoDates()
      break
    default:
      throw new Error(`Unknown dates impl "${config.dates.impl}"`)
  }

  switch (config.resolver.impl) {
    case 'ollama':
      caps.resolver = new OllamaResolver(config.resolver as { host: string; model: string })
      break
    case 'laya':
      caps.resolver = new LayaResolver(config.resolver as { checkpoint: string })
      break
    default:
      throw new Error(`Unknown resolver impl "${config.resolver.impl}"`)
  }

  if (config.generator) {
    if (config.generator.impl !== 'ollama')
      throw new Error(`Unknown generator impl "${config.generator.impl}"`)
    caps.generator = new OllamaGenerator(config.generator)
  }
  if (config.agent && config.agent.enabled) {
    if (config.agent.impl !== 'claude-cli')
      throw new Error(`Unknown agent impl "${config.agent.impl}"`)
    caps.agent = new ClaudeAgent()
  }
  return caps as Capabilities
}
```

For this task, create `ollama-resolver.ts`, `ollama-generator.ts`, `laya-resolver.ts`, `claude-agent.ts` as classes whose constructors store config and whose methods `throw new Error('<name>: not implemented yet (Task 10/12)')` — compile-complete, behavior arrives in Tasks 10/12. (Constructors must not do IO; binding stays cheap and testable.)

- [ ] **Step 4: Run, PASS.** **Step 5: Commit** — `git commit -am "feat: capability contracts, chrono dates, binder"`

---

### Task 6: Pre-pass

**Files:**
- Create: `src/main/tasks/prepass.ts`
- Test: `src/main/__tests__/prepass.test.ts`

**Interfaces:**
- Consumes: `Dates` contract.
- Produces:

```ts
export interface PrepassResult {
  meta?: 'clean'            // registry keys with class "meta", matched verbatim
  refs: string[]            // #shortname tokens, stripped of '#'
  due?: string
  cleaned: string           // text minus date phrase; refs left in place
}
export function prepass(raw: string, dates: Dates, now: Date, registry: Registry): PrepassResult
```

- [ ] **Step 1: Failing tests**

```ts
// src/main/__tests__/prepass.test.ts
import { describe, it, expect } from 'vitest'
import { prepass } from '../tasks/prepass'
import { ChronoDates } from '../capabilities/chrono-dates'
import type { Registry } from '../tasks/types'

const registry: Registry = { clean: { class: 'meta' }, create: { class: 'normal' } }
const dates = new ChronoDates()
const now = new Date('2026-10-02T10:00:00')

describe('prepass', () => {
  it('detects meta commands verbatim', () => {
    expect(prepass('clean', dates, now, registry).meta).toBe('clean')
    expect(prepass('clean the house this wed', dates, now, registry).meta).toBeUndefined()
  })
  it('extracts #refs and dates', () => {
    const r = prepass('link #proposal-y to #ngo-app this wed', dates, now, registry)
    expect(r.refs).toEqual(['proposal-y', 'ngo-app'])
    expect(r.due).toBe('2026-10-07')
    expect(r.cleaned).toBe('link #proposal-y to #ngo-app')
  })
})
```

- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement**

```ts
// src/main/tasks/prepass.ts
import type { Dates } from '../capabilities/contracts'
import type { Registry } from './types'

export interface PrepassResult {
  meta?: string
  refs: string[]
  due?: string
  cleaned: string
}

export function prepass(raw: string, dates: Dates, now: Date, registry: Registry): PrepassResult {
  const trimmed = raw.trim()
  const metaKeys = Object.keys(registry).filter((k) => registry[k].class === 'meta')
  if (metaKeys.includes(trimmed.toLowerCase())) {
    return { meta: trimmed.toLowerCase(), refs: [], cleaned: trimmed }
  }
  const refs = [...trimmed.matchAll(/#([a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase())
  const { due, cleaned } = dates.extract(trimmed, now)
  return { refs, due, cleaned }
}
```

- [ ] **Step 4: Run, PASS.** **Step 5: Commit** — `git commit -am "feat: instruction pre-pass (meta, refs, dates)"`

---

### Task 7: Candidate selection + resolution

**Files:**
- Create: `src/main/tasks/candidates.ts`, `src/main/tasks/resolve.ts`
- Test: `src/main/__tests__/resolve.test.ts`

**Interfaces:**
- Consumes: `Resolver` contract, `PrepassResult`, `Registry`, `Card`, thresholds from config.
- Produces:

```ts
// candidates.ts
export function selectCandidates(cleaned: string, cards: Card[], max = 8): Card[]
// keyword overlap between cleaned text tokens and card title+shortname tokens,
// ties broken by created desc; returns [] when no overlap at all

// resolve.ts
export type Resolution =
  | { kind: 'action'; action: string; card?: string; status?: string }
  | { kind: 'attention'; error: string }
export async function resolveInstruction(
  pre: PrepassResult, cards: Card[], registry: Registry,
  resolver: Resolver, thresholds: { action: number; card: number; status: number }
): Promise<Resolution>
```

Resolution rules (exact):
1. Action question: options = non-meta registry keys with fixed one-line descriptions (`create`: "start a new task card", `update_status`: "change the status of an existing card", `note`: "add a note to an existing card", `link`: "link two existing cards", `delete`: "delete an existing card", `delegate`: "produce content with an executor"). Confidence < `thresholds.action` → attention `low confidence on action (<got> <conf>)`.
2. Card question — only for actions needing a target (`update_status`, `note`, `delete`, `delegate` when refs empty; `link` requires ≥2 refs, else attention `link requires two #refs`). If `pre.refs` has entries, use `refs[0]` (and `refs[1]` for link) and skip the question. Otherwise options = `selectCandidates()` + `{ key: 'none', description: 'none of these cards' }`; empty candidates or answer `none` or confidence < `thresholds.card` → attention `could not resolve target card`.
3. Status question — only for `update_status`: options from `registry.update_status.params.status`, each with description equal to the status word; confidence < `thresholds.status` → attention.
4. `create` never asks card/status questions.

- [ ] **Step 1: Failing tests**

```ts
// src/main/__tests__/resolve.test.ts
import { describe, it, expect } from 'vitest'
import { selectCandidates } from '../tasks/candidates'
import { resolveInstruction } from '../tasks/resolve'
import type { Card, Registry } from '../tasks/types'
import type { Choice, Resolver } from '../capabilities/contracts'

const card = (shortname: string, title: string, created = '2026-10-01'): Card => ({
  shortname, title, created, path: '', status: 'inbox', links: [], labels: [], description: '', log: []
})
const registry: Registry = {
  create: { class: 'normal' },
  update_status: { class: 'normal', params: { status: ['inbox', 'active', 'waiting', 'done', 'dropped'] } },
  note: { class: 'normal' }, link: { class: 'normal' }, delete: { class: 'destructive' },
  delegate: { class: 'normal', params: { executor: ['generator', 'agent'] } }, clean: { class: 'meta' }
}
const thresholds = { action: 0.65, card: 0.6, status: 0.6 }

// scripted resolver: answers queued per question, records asked questions
function scripted(answers: Array<{ key: string; confidence: number }>): Resolver & { asked: Choice[] } {
  const asked: Choice[] = []
  return {
    asked,
    async decide(q: Choice) {
      asked.push(q)
      const a = answers.shift()
      if (!a) throw new Error('no scripted answer left')
      return a
    }
  }
}

describe('selectCandidates', () => {
  it('ranks by keyword overlap', () => {
    const cards = [card('ngo-app', 'NGO application'), card('proposal-y', 'Proposal for Y')]
    const out = selectCandidates('proposal for Y got declined', cards)
    expect(out[0].shortname).toBe('proposal-y')
  })
  it('returns empty with zero overlap', () => {
    expect(selectCandidates('totally unrelated', [card('a', 'B C')])).toEqual([])
  })
})

describe('resolveInstruction', () => {
  const pre = { refs: [], cleaned: 'proposal for Y got declined' }
  it('resolves action, card, status', async () => {
    const r = scripted([
      { key: 'update_status', confidence: 0.9 },
      { key: 'proposal-y', confidence: 0.8 },
      { key: 'dropped', confidence: 0.75 }
    ])
    const res = await resolveInstruction(pre, [card('proposal-y', 'Proposal for Y')], registry, r, thresholds)
    expect(res).toEqual({ kind: 'action', action: 'update_status', card: 'proposal-y', status: 'dropped' })
    expect(r.asked[0].options.map((o) => o.key)).not.toContain('clean') // meta excluded
    expect(r.asked[1].options.map((o) => o.key)).toContain('none')
  })
  it('goes to attention below action threshold', async () => {
    const r = scripted([{ key: 'note', confidence: 0.3 }])
    const res = await resolveInstruction(pre, [], registry, r, thresholds)
    expect(res.kind).toBe('attention')
  })
  it('skips the card question when a #ref exists', async () => {
    const r = scripted([{ key: 'note', confidence: 0.9 }])
    const res = await resolveInstruction(
      { refs: ['proposal-y'], cleaned: 'add context' }, [], registry, r, thresholds
    )
    expect(res).toEqual({ kind: 'action', action: 'note', card: 'proposal-y' })
    expect(r.asked).toHaveLength(1)
  })
  it('create asks exactly one question', async () => {
    const r = scripted([{ key: 'create', confidence: 0.9 }])
    const res = await resolveInstruction({ refs: [], cleaned: 'write the ngo proposal' }, [], registry, r, thresholds)
    expect(res).toEqual({ kind: 'action', action: 'create' })
    expect(r.asked).toHaveLength(1)
  })
})
```

- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement `candidates.ts` and `resolve.ts`**

```ts
// src/main/tasks/candidates.ts
import type { Card } from './types'

const tokens = (s: string): Set<string> =>
  new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2))

export function selectCandidates(cleaned: string, cards: Card[], max = 8): Card[] {
  const t = tokens(cleaned)
  return cards
    .map((c) => {
      const ct = tokens(`${c.title} ${c.shortname.replace(/-/g, ' ')}`)
      let score = 0
      for (const tok of ct) if (t.has(tok)) score++
      return { c, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.c.created.localeCompare(a.c.created))
    .slice(0, max)
    .map((x) => x.c)
}
```

```ts
// src/main/tasks/resolve.ts
import type { Card, Registry } from './types'
import type { Resolver } from '../capabilities/contracts'
import type { PrepassResult } from './prepass'
import { selectCandidates } from './candidates'

const ACTION_DESCRIPTIONS: Record<string, string> = {
  create: 'start a new task card',
  update_status: 'change the status of an existing card',
  note: 'add a note to an existing card',
  link: 'link two existing cards',
  delete: 'delete an existing card',
  delegate: 'produce content with an executor'
}
const NEEDS_CARD = ['update_status', 'note', 'delete', 'delegate']

export type Resolution =
  | { kind: 'action'; action: string; card?: string; status?: string }
  | { kind: 'attention'; error: string }

export async function resolveInstruction(
  pre: PrepassResult,
  cards: Card[],
  registry: Registry,
  resolver: Resolver,
  thresholds: { action: number; card: number; status: number }
): Promise<Resolution> {
  const actionKeys = Object.keys(registry).filter((k) => registry[k].class !== 'meta')
  const a = await resolver.decide({
    context: pre.cleaned,
    question: 'What does this instruction ask for?',
    options: actionKeys.map((key) => ({ key, description: ACTION_DESCRIPTIONS[key] ?? key }))
  })
  if (a.confidence < thresholds.action)
    return { kind: 'attention', error: `low confidence on action (${a.key} ${a.confidence})` }
  const action = a.key

  if (action === 'link') {
    if (pre.refs.length < 2) return { kind: 'attention', error: 'link requires two #refs' }
    return { kind: 'action', action, card: pre.refs[0] }
  }

  let targetCard: string | undefined
  if (NEEDS_CARD.includes(action)) {
    if (pre.refs.length > 0) {
      targetCard = pre.refs[0]
    } else {
      const candidates = selectCandidates(pre.cleaned, cards)
      if (candidates.length === 0)
        return { kind: 'attention', error: 'could not resolve target card' }
      const c = await resolver.decide({
        context: pre.cleaned,
        question: 'Which card does this instruction refer to?',
        options: [
          ...candidates.map((card) => ({ key: card.shortname, description: card.title })),
          { key: 'none', description: 'none of these cards' }
        ]
      })
      if (c.key === 'none' || c.confidence < thresholds.card)
        return { kind: 'attention', error: 'could not resolve target card' }
      targetCard = c.key
    }
  }

  if (action === 'update_status') {
    const statuses = registry.update_status.params?.status ?? []
    const s = await resolver.decide({
      context: pre.cleaned,
      question: 'Which status does this instruction set?',
      options: statuses.map((key) => ({ key, description: key }))
    })
    if (s.confidence < thresholds.status)
      return { kind: 'attention', error: `low confidence on status (${s.key} ${s.confidence})` }
    return { kind: 'action', action, card: targetCard, status: s.key }
  }

  return { kind: 'action', action, card: targetCard }
}
```

- [ ] **Step 4: Run, PASS.** **Step 5: Commit** — `git commit -am "feat: candidate selection and bounded resolution"`

---

### Task 8: Handlers

**Files:**
- Create: `src/main/tasks/handlers.ts`
- Test: `src/main/__tests__/handlers.test.ts`

**Interfaces:**
- Consumes: files.ts, types, `Generator` contract, `PrepassResult`, `Resolution`.
- Produces:

```ts
export interface HandlerCtx {
  tasksDir: string
  now: Date
  generator?: Generator
}
// each returns a one-line human summary for the instruction's frontmatter-adjacent use
export async function handleCreate(ctx: HandlerCtx, pre: PrepassResult): Promise<string>  // returns shortname
export function handleUpdateStatus(ctx: HandlerCtx, card: string, status: CardStatus, raw: string): string
export function handleNote(ctx: HandlerCtx, card: string, raw: string): string
export function handleLink(ctx: HandlerCtx, a: string, b: string): string
export function handleDelete(ctx: HandlerCtx, card: string): string
```

Rules: `handleCreate` title = `generator.complete(TITLE_PROMPT + cleaned)` when generator bound, else `cleaned` as-is (declared unbound path, not a fallback); status `inbox`; due from pre. Handlers that target a card throw `Error('card not found: x')` if the file is absent (engine maps to attention). All mutations are re-runnable without duplication except log appends (acceptable: a re-run only happens after crash-before-done; duplicated log lines are visible history, never corrupt state).

- [ ] **Step 1: Failing tests**

```ts
// src/main/__tests__/handlers.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeCard, readCard } from '../tasks/files'
import { handleCreate, handleUpdateStatus, handleNote, handleLink, handleDelete } from '../tasks/handlers'

function dir(): string {
  const d = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const s of ['queue', 'cards', 'artifacts']) mkdirSync(join(d, s), { recursive: true })
  return d
}
const now = new Date('2026-10-02T10:12:00')

describe('handlers', () => {
  it('create writes a card with slug, due, inbox status; raw title without generator', async () => {
    const tasksDir = dir()
    const shortname = await handleCreate(
      { tasksDir, now },
      { refs: [], cleaned: 'write the NGO proposal', due: '2026-10-07' }
    )
    const card = readCard(join(tasksDir, 'cards', `${shortname}.md`))
    expect(card.status).toBe('inbox')
    expect(card.due).toBe('2026-10-07')
    expect(card.title).toBe('write the NGO proposal')
  })
  it('create uses the generator for the title when bound', async () => {
    const tasksDir = dir()
    const generator = { complete: async () => 'Write NGO proposal' }
    const shortname = await handleCreate({ tasksDir, now, generator }, { refs: [], cleaned: 'gotta write the ngo proposal' })
    expect(readCard(join(tasksDir, 'cards', `${shortname}.md`)).title).toBe('Write NGO proposal')
  })
  it('update_status changes frontmatter and appends a log line with the raw text', () => {
    const tasksDir = dir()
    writeCard(tasksDir, { shortname: 'p-y', title: 'P Y', status: 'active', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
    handleUpdateStatus({ tasksDir, now }, 'p-y', 'dropped', 'proposal for Y got declined')
    const card = readCard(join(tasksDir, 'cards', 'p-y.md'))
    expect(card.status).toBe('dropped')
    expect(card.log[0]).toContain('proposal for Y got declined')
  })
  it('link adds both directions; delete removes the file', () => {
    const tasksDir = dir()
    for (const s of ['a', 'b'])
      writeCard(tasksDir, { shortname: s, title: s, status: 'inbox', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
    handleLink({ tasksDir, now }, 'a', 'b')
    expect(readCard(join(tasksDir, 'cards', 'a.md')).links).toContain('b')
    expect(readCard(join(tasksDir, 'cards', 'b.md')).links).toContain('a')
    handleDelete({ tasksDir, now }, 'a')
    expect(existsSync(join(tasksDir, 'cards', 'a.md'))).toBe(false)
  })
  it('targeting a missing card throws', () => {
    expect(() => handleNote({ tasksDir: dir(), now }, 'ghost', 'hello')).toThrow(/card not found/)
  })
})
```

- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement**

```ts
// src/main/tasks/handlers.ts
import { existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { writeCard, readCard, appendLog, slugify } from './files'
import type { CardStatus } from './types'
import type { Generator } from '../capabilities/contracts'
import type { PrepassResult } from './prepass'

export interface HandlerCtx {
  tasksDir: string
  now: Date
  generator?: Generator
}

const TITLE_PROMPT =
  'Rewrite the following task note as a short imperative title (max 8 words). Reply with the title only.\n\n'

const stamp = (now: Date): string => now.toISOString().slice(0, 16).replace('T', ' ')

function cardPath(ctx: HandlerCtx, card: string): string {
  const p = join(ctx.tasksDir, 'cards', `${card}.md`)
  if (!existsSync(p)) throw new Error(`card not found: ${card}`)
  return p
}

export async function handleCreate(ctx: HandlerCtx, pre: PrepassResult): Promise<string> {
  const title = ctx.generator ? (await ctx.generator.complete(TITLE_PROMPT + pre.cleaned)).trim() : pre.cleaned
  const taken = new Set(readdirSync(join(ctx.tasksDir, 'cards')).map((f) => f.replace(/\.md$/, '')))
  const shortname = slugify(title, taken)
  writeCard(ctx.tasksDir, {
    shortname,
    title,
    status: 'inbox',
    created: ctx.now.toISOString().slice(0, 10),
    due: pre.due,
    links: pre.refs,
    labels: [],
    description: pre.cleaned,
    log: [`${stamp(ctx.now)} — created`]
  })
  return shortname
}

export function handleUpdateStatus(ctx: HandlerCtx, card: string, status: CardStatus, raw: string): string {
  const path = cardPath(ctx, card)
  const existing = readCard(path)
  writeCard(ctx.tasksDir, { ...existing, status })
  appendLog(path, `${stamp(ctx.now)} — status → ${status} ("${raw}")`)
  return `#${card} → ${status}`
}

export function handleNote(ctx: HandlerCtx, card: string, raw: string): string {
  appendLog(cardPath(ctx, card), `${stamp(ctx.now)} — ${raw}`)
  return `note on #${card}`
}

export function handleLink(ctx: HandlerCtx, a: string, b: string): string {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const path = cardPath(ctx, x)
    const card = readCard(path)
    if (!card.links.includes(y)) writeCard(ctx.tasksDir, { ...card, links: [...card.links, y] })
  }
  return `#${a} ↔ #${b}`
}

export function handleDelete(ctx: HandlerCtx, card: string): string {
  rmSync(cardPath(ctx, card))
  return `deleted #${card}`
}
```

- [ ] **Step 4: Run, PASS.** **Step 5: Commit** — `git commit -am "feat: card handlers (create, status, note, link, delete)"`

---

### Task 9: Engine — pipeline, per-card FIFO, attention freeze, confirmation

**Files:**
- Create: `src/main/tasks/engine.ts`
- Test: `src/main/__tests__/engine.test.ts`
- Install: `npm i chokidar`

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
export interface EngineDeps {
  tasksDir: string
  registry: Registry
  config: TaskdeckConfig
  caps: Capabilities
  onChange: () => void          // called after any state-changing write (server broadcasts)
  now?: () => Date
}
export class Engine {
  constructor(deps: EngineDeps)
  start(): void                                   // chokidar watch queue/ + cards/; boot scan
  stop(): Promise<void>
  async processFile(path: string): Promise<void>  // full pipeline for one instruction (public for tests)
  confirm(id: string): Promise<void>              // execute a needs_confirmation instruction
  reject(id: string): void                        // mark done with error:'rejected'
  requeue(id: string, text?: string): void        // attention → queued (optionally replacing body), unfreezes card
}
```

Engine rules (exact):
- Boot scan: every `working` file reverts to `queued` (crash recovery), then all `queued` files process.
- `processFile` skips files whose status isn't `queued`, or already in the in-memory `inflight` set.
- Pipeline: claim (`status: working`) → `prepass` → meta? run meta handler (`clean` = delete all `done` queue files) → mark `done` → return. Otherwise `resolveInstruction` → attention? write `status: attention, error` and **freeze**: add resolved/failed card (if any) to `frozen` set → return. Destructive class → `status: needs_confirmation, action, card`; arm a `setTimeout(confirmation_timeout_s * 1000)` that rejects. Otherwise execute via per-card chain: `chains.set(card, (chains.get(card) ?? Promise.resolve()).then(run))` where `run` calls the handler, then `patchInstruction(path, { status: 'done', action, card })`. Handler throw → `attention` + freeze card.
- Frozen cards: an instruction whose resolved card is frozen stays `queued` (release claim back to `queued`) — it reprocesses on `requeue`/`reject`/`delete` of the attention instruction (engine rescans queue then).
- Every status write calls `onChange()`.
- `delegate` handling arrives in Task 10 — until then resolver never returns it in tests.

- [ ] **Step 1: Failing tests**

```ts
// src/main/__tests__/engine.test.ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { Engine } from '../tasks/engine'
import { writeInstruction, readInstruction, writeCard, readCard } from '../tasks/files'
import type { Registry, TaskdeckConfig } from '../tasks/types'
import type { Capabilities, Choice } from '../capabilities/contracts'

const registry: Registry = {
  create: { class: 'normal' },
  update_status: { class: 'normal', params: { status: ['inbox', 'active', 'waiting', 'done', 'dropped'] } },
  note: { class: 'normal' }, link: { class: 'normal' }, delete: { class: 'destructive' },
  delegate: { class: 'normal', params: { executor: ['generator', 'agent'] } }, clean: { class: 'meta' }
}
const config: TaskdeckConfig = {
  resolver: { impl: 'test' }, dates: { impl: 'chrono' },
  thresholds: { action: 0.65, card: 0.6, status: 0.6 },
  jobs: { max_parallel: 3 }, confirmation_timeout_s: 1
}

function setup(answers: Array<{ key: string; confidence: number }>) {
  const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const s of ['queue', 'cards', 'artifacts']) mkdirSync(join(tasksDir, s), { recursive: true })
  const caps: Capabilities = {
    dates: { extract: (t: string) => ({ cleaned: t }) },
    resolver: { decide: async (_q: Choice) => answers.shift() ?? { key: 'create', confidence: 0.9 } }
  }
  const onChange = vi.fn()
  const engine = new Engine({ tasksDir, registry, config, caps, onChange, now: () => new Date('2026-10-02T10:00:00') })
  return { tasksDir, engine, onChange }
}
const qpath = (tasksDir: string, id: string): string => join(tasksDir, 'queue', `${id}.md`)

describe('Engine.processFile', () => {
  it('create: queued → done, card exists', async () => {
    const { tasksDir, engine } = setup([{ key: 'create', confidence: 0.9 }])
    const id = writeInstruction(tasksDir, 'write the ngo proposal', new Date())
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
    expect(readdirSync(join(tasksDir, 'cards'))).toHaveLength(1)
  })
  it('attention freezes the card: later instructions stay queued', async () => {
    const { tasksDir, engine } = setup([
      { key: 'update_status', confidence: 0.9 }, { key: 'p-y', confidence: 0.9 }, { key: 'dropped', confidence: 0.2 }, // → attention
      { key: 'note', confidence: 0.9 }, { key: 'p-y', confidence: 0.9 }
    ])
    writeCard(tasksDir, { shortname: 'p-y', title: 'proposal y', status: 'active', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
    const first = writeInstruction(tasksDir, 'proposal y declined', new Date('2026-10-02T10:00:00'))
    const second = writeInstruction(tasksDir, 'add proposal y note', new Date('2026-10-02T10:00:01'))
    await engine.processFile(qpath(tasksDir, first))
    await engine.processFile(qpath(tasksDir, second))
    expect(readInstruction(qpath(tasksDir, first)).status).toBe('attention')
    expect(readInstruction(qpath(tasksDir, second)).status).toBe('queued') // frozen, not processed
  })
  it('requeue unfreezes and reprocesses', async () => {
    const { tasksDir, engine } = setup([
      { key: 'note', confidence: 0.9 }, { key: 'none', confidence: 0.9 },          // attention: no card
      { key: 'create', confidence: 0.9 }                                            // after requeue
    ])
    writeCard(tasksDir, { shortname: 'x', title: 'x note thing', status: 'inbox', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
    const id = writeInstruction(tasksDir, 'note thing', new Date())
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('attention')
    engine.requeue(id, 'make a brand new card')
    await engine.drain()
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
  })
  it('destructive parks as needs_confirmation; confirm executes; reject closes', async () => {
    const { tasksDir, engine } = setup([
      { key: 'delete', confidence: 0.95 },
      { key: 'delete', confidence: 0.95 }
    ])
    for (const s of ['a', 'b'])
      writeCard(tasksDir, { shortname: s, title: s, status: 'inbox', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
    const one = writeInstruction(tasksDir, 'delete #a', new Date('2026-10-02T10:00:00'))
    const two = writeInstruction(tasksDir, 'delete #b', new Date('2026-10-02T10:00:01'))
    await engine.processFile(qpath(tasksDir, one))
    await engine.processFile(qpath(tasksDir, two))
    expect(readInstruction(qpath(tasksDir, one)).status).toBe('needs_confirmation')
    await engine.confirm(one)
    expect(readInstruction(qpath(tasksDir, one)).status).toBe('done')
    expect(existsSync(join(tasksDir, 'cards', 'a.md'))).toBe(false)
    engine.reject(two)
    expect(readInstruction(qpath(tasksDir, two)).status).toBe('done')
    expect(readInstruction(qpath(tasksDir, two)).error).toBe('rejected')
    expect(existsSync(join(tasksDir, 'cards', 'b.md'))).toBe(true)
  })
  it('clean removes done queue files', async () => {
    const { tasksDir, engine } = setup([{ key: 'create', confidence: 0.9 }])
    const a = writeInstruction(tasksDir, 'make something', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, a))
    const c = writeInstruction(tasksDir, 'clean', new Date('2026-10-02T10:00:01'))
    await engine.processFile(qpath(tasksDir, c))
    expect(existsSync(qpath(tasksDir, a))).toBe(false)
    expect(existsSync(qpath(tasksDir, c))).toBe(false) // clean removes itself too
  })
})
```

Note: the test calls `engine.drain(): Promise<void>` — expose it: resolves when all in-flight work (including requeue-triggered rescans) settles. Implement as awaiting the union of all live chains.

- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement `engine.ts`**

```ts
// src/main/tasks/engine.ts
import { watch, FSWatcher } from 'chokidar'
import { readdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { readInstruction, patchInstruction, writeInstruction } from './files'
import { readSnapshot } from './snapshot'
import { prepass } from './prepass'
import { resolveInstruction } from './resolve'
import { handleCreate, handleUpdateStatus, handleNote, handleLink, handleDelete } from './handlers'
import type { Registry, TaskdeckConfig, CardStatus } from './types'
import type { Capabilities } from '../capabilities/contracts'

export interface EngineDeps {
  tasksDir: string
  registry: Registry
  config: TaskdeckConfig
  caps: Capabilities
  onChange: () => void
  now?: () => Date
}

interface Pending {
  action: string
  card?: string
  status?: string
  timer: ReturnType<typeof setTimeout>
}

export class Engine {
  private deps: EngineDeps
  private watchers: FSWatcher[] = []
  private inflight = new Set<string>()
  private frozen = new Set<string>()
  private chains = new Map<string, Promise<void>>()
  private pendingConfirm = new Map<string, Pending>()
  private live: Promise<void>[] = []

  constructor(deps: EngineDeps) {
    this.deps = deps
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }
  private queueDir(): string {
    return join(this.deps.tasksDir, 'queue')
  }
  private qpath(id: string): string {
    return join(this.queueDir(), `${id}.md`)
  }

  start(): void {
    // crash recovery: working → queued
    for (const f of readdirSync(this.queueDir()).filter((n) => n.endsWith('.md'))) {
      const p = join(this.queueDir(), f)
      try {
        if (readInstruction(p).status === 'working') patchInstruction(p, { status: 'queued' })
      } catch (err) {
        console.error('engine boot: skipping unparseable', f, err)
      }
    }
    const q = watch(this.queueDir(), { ignoreInitial: false, depth: 0 })
    q.on('add', (p) => this.track(this.processFile(p)))
    q.on('change', () => this.deps.onChange())
    q.on('unlink', () => this.deps.onChange())
    const c = watch(join(this.deps.tasksDir, 'cards'), { ignoreInitial: true, depth: 0 })
    for (const ev of ['add', 'change', 'unlink'] as const) c.on(ev, () => this.deps.onChange())
    this.watchers = [q, c]
  }

  async stop(): Promise<void> {
    for (const w of this.watchers) await w.close()
    for (const p of this.pendingConfirm.values()) clearTimeout(p.timer)
  }

  private track(p: Promise<void>): void {
    this.live.push(p.catch((err) => console.error('engine:', err)))
  }

  async drain(): Promise<void> {
    let count = -1
    while (count !== this.live.length) {
      count = this.live.length
      await Promise.all([...this.live])
    }
  }

  async processFile(path: string): Promise<void> {
    if (this.inflight.has(path)) return
    let inst
    try {
      inst = readInstruction(path)
    } catch {
      return // half-written hand edit; watcher fires again on save
    }
    if (inst.status !== 'queued') return
    this.inflight.add(path)
    try {
      await this.pipeline(path, inst.raw)
    } finally {
      this.inflight.delete(path)
    }
  }

  private setStatus(
    path: string,
    patch: Parameters<typeof patchInstruction>[1]
  ): void {
    patchInstruction(path, patch)
    this.deps.onChange()
  }

  private async pipeline(path: string, raw: string): Promise<void> {
    const { tasksDir, registry, config, caps } = this.deps
    this.setStatus(path, { status: 'working' })

    const pre = prepass(raw, caps.dates, this.now(), registry)
    if (pre.meta === 'clean') {
      for (const f of readdirSync(this.queueDir()).filter((n) => n.endsWith('.md'))) {
        const p = join(this.queueDir(), f)
        try {
          if (p !== path && readInstruction(p).status === 'done') rmSync(p)
        } catch { /* skip */ }
      }
      rmSync(path)
      this.deps.onChange()
      return
    }

    let resolution
    try {
      const { cards } = readSnapshot(tasksDir)
      resolution = await resolveInstruction(pre, cards, registry, caps.resolver, config.thresholds)
    } catch (err) {
      this.setStatus(path, { status: 'attention', error: err instanceof Error ? err.message : String(err) })
      return
    }

    if (resolution.kind === 'attention') {
      this.setStatus(path, { status: 'attention', error: resolution.error })
      if (pre.refs[0]) this.frozen.add(pre.refs[0])
      return
    }

    const { action, card, status } = resolution
    if (card && this.frozen.has(card)) {
      this.setStatus(path, { status: 'queued' }) // wait for the attention to clear
      return
    }

    if (registry[action].class === 'destructive') {
      const id = path.split('/').pop()!.replace(/\.md$/, '')
      this.setStatus(path, { status: 'needs_confirmation', action, card })
      const timer = setTimeout(() => this.reject(id), config.confirmation_timeout_s * 1000)
      this.pendingConfirm.set(id, { action, card, status, timer })
      return
    }

    await this.execute(path, raw, pre, action, card, status)
  }

  private execute(
    path: string,
    raw: string,
    pre: ReturnType<typeof prepass>,
    action: string,
    card?: string,
    status?: string
  ): Promise<void> {
    const key = card ?? '__new__'
    const run = async (): Promise<void> => {
      const ctx = { tasksDir: this.deps.tasksDir, now: this.now(), generator: this.deps.caps.generator }
      try {
        let resolvedCard = card
        if (action === 'create') resolvedCard = await handleCreate(ctx, pre)
        else if (action === 'update_status') handleUpdateStatus(ctx, card!, status as CardStatus, raw)
        else if (action === 'note') handleNote(ctx, card!, raw)
        else if (action === 'link') handleLink(ctx, pre.refs[0], pre.refs[1])
        else if (action === 'delete') handleDelete(ctx, card!)
        else if (action === 'delegate') await this.delegate(ctx, card!, raw) // Task 10
        else throw new Error(`no handler for action "${action}"`)
        this.setStatus(path, { status: 'done', action, card: resolvedCard })
      } catch (err) {
        this.setStatus(path, {
          status: 'attention',
          action,
          card,
          error: err instanceof Error ? err.message : String(err)
        })
        if (card) this.frozen.add(card)
      }
    }
    const chained = (this.chains.get(key) ?? Promise.resolve()).then(run)
    this.chains.set(key, chained)
    this.track(chained)
    return chained
  }

  // replaced in Task 10
  protected async delegate(_ctx: unknown, _card: string, _raw: string): Promise<void> {
    throw new Error('delegate: no executor wired yet')
  }

  async confirm(id: string): Promise<void> {
    const pending = this.pendingConfirm.get(id)
    if (!pending) throw new Error(`no pending confirmation for ${id}`)
    clearTimeout(pending.timer)
    this.pendingConfirm.delete(id)
    const path = this.qpath(id)
    const inst = readInstruction(path)
    const pre = prepass(inst.raw, this.deps.caps.dates, this.now(), this.deps.registry)
    await this.execute(path, inst.raw, pre, pending.action, pending.card, pending.status)
  }

  reject(id: string): void {
    const pending = this.pendingConfirm.get(id)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingConfirm.delete(id)
    }
    if (existsSync(this.qpath(id))) this.setStatus(this.qpath(id), { status: 'done', error: 'rejected' })
  }

  requeue(id: string, text?: string): void {
    const path = this.qpath(id)
    const inst = readInstruction(path)
    if (inst.card) this.frozen.delete(inst.card)
    for (const ref of inst.raw.matchAll(/#([a-z0-9-]+)/gi)) this.frozen.delete(ref[1].toLowerCase())
    if (text !== undefined) {
      rmSync(path)
      const newId = writeInstruction(this.deps.tasksDir, text, this.now())
      this.track(this.processFile(this.qpath(newId)))
    } else {
      this.setStatus(path, { status: 'queued', error: undefined })
      this.track(this.processFile(path))
    }
    this.rescanQueued()
  }

  private rescanQueued(): void {
    for (const f of readdirSync(this.queueDir()).filter((n) => n.endsWith('.md'))) {
      this.track(this.processFile(join(this.queueDir(), f)))
    }
  }
}
```

Note for the test `requeue unfreezes and reprocesses`: requeue with replacement text creates a new id — adjust the final assertion to scan the queue dir for the single remaining instruction and expect its status `done` (the old file is gone). Write the test that way from the start:

```ts
    engine.requeue(id, 'make a brand new card')
    await engine.drain()
    const left = readdirSync(join(tasksDir, 'queue')).map((f) => readInstruction(join(tasksDir, 'queue', f)))
    expect(left).toHaveLength(1)
    expect(left[0].status).toBe('done')
```

- [ ] **Step 4: Run, PASS** — `npx vitest run engine`. Also full suite: `npx vitest run`.
- [ ] **Step 5: Commit** — `git commit -am "feat: taskdeck engine (pipeline, FIFO, attention freeze, confirmation gate)"`

---

### Task 10: Delegation — jobs pool, Ollama generator, Claude agent

**Files:**
- Create: `src/main/tasks/jobs.ts`
- Modify: `src/main/capabilities/ollama-generator.ts`, `src/main/capabilities/claude-agent.ts`, `src/main/tasks/engine.ts` (replace `delegate` stub)
- Test: `src/main/__tests__/jobs.test.ts`

**Interfaces:**
- Produces:

```ts
// jobs.ts
export class JobPool {
  constructor(maxParallel: number)
  run<T>(job: () => Promise<T>): Promise<T>   // queues beyond maxParallel
  get active(): number
}
// ollama-generator.ts
export class OllamaGenerator implements Generator {
  constructor(cfg: { host: string; model: string }, fetchImpl?: typeof fetch)
  complete(prompt: string): Promise<string>   // POST {host}/api/generate {model, prompt, stream:false} → response.response; non-200 → throw
}
// claude-agent.ts
export class ClaudeAgent implements Agent {
  constructor(spawnImpl?: typeof import('child_process').spawn)
  run(prompt: string, cwd: string): Promise<string> // spawn('claude', ['-p', prompt], {cwd}); stdout; nonzero exit → throw with stderr
}
```

- Engine `delegate(ctx, card, raw)` becomes: executor question via resolver (`options: registry.delegate.params.executor` → `generator` | `agent`, threshold `action`); chosen capability must be bound else throw `delegate: ${key} not bound in config`; run through `JobPool`; write output to `artifacts/<card>/<stamp>.md`; `appendLog(card, '<stamp> — delegated (<executor>) → artifacts/<card>/<file>')`.

- [ ] **Step 1: Failing tests**

```ts
// src/main/__tests__/jobs.test.ts
import { describe, it, expect } from 'vitest'
import { JobPool } from '../tasks/jobs'
import { OllamaGenerator } from '../capabilities/ollama-generator'
import { ClaudeAgent } from '../capabilities/claude-agent'
import { EventEmitter } from 'events'

describe('JobPool', () => {
  it('caps concurrency', async () => {
    const pool = new JobPool(2)
    let peak = 0
    const job = () =>
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
      expect(JSON.parse(init.body as string).stream).toBe(false)
      return { ok: true, json: async () => ({ response: 'a title' }) }
    }) as unknown as typeof fetch
    const g = new OllamaGenerator({ host: 'http://h', model: 'm' }, fetchImpl)
    expect(await g.complete('p')).toBe('a title')
  })
  it('throws on non-200 with the real error', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, text: async () => 'down' })) as unknown as typeof fetch
    const g = new OllamaGenerator({ host: 'http://h', model: 'm' }, fetchImpl)
    await expect(g.complete('p')).rejects.toThrow(/503/)
  })
})

describe('ClaudeAgent', () => {
  function fakeProc(code: number, stdout: string, stderr = ''): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
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
```

- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement**

```ts
// src/main/tasks/jobs.ts
export class JobPool {
  private max: number
  private running = 0
  private waiting: Array<() => void> = []
  constructor(maxParallel: number) {
    this.max = maxParallel
  }
  get active(): number {
    return this.running
  }
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiting.push(r))
    this.running++
    try {
      return await job()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}
```

```ts
// src/main/capabilities/ollama-generator.ts
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
      body: JSON.stringify({ model: this.cfg.model, prompt, stream: false })
    })
    if (!res.ok) throw new Error(`ollama generate failed: ${res.status} ${await res.text()}`)
    return ((await res.json()) as { response: string }).response
  }
}
```

```ts
// src/main/capabilities/claude-agent.ts
import { spawn as nodeSpawn } from 'child_process'
import type { Agent } from './contracts'

export class ClaudeAgent implements Agent {
  constructor(private spawnImpl: typeof nodeSpawn = nodeSpawn) {}
  run(prompt: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnImpl('claude', ['-p', prompt], { cwd })
      let out = ''
      let err = ''
      proc.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      proc.stderr?.on('data', (d: Buffer) => (err += d.toString()))
      proc.on('error', reject)
      proc.on('close', (code: number) => {
        if (code === 0) resolve(out.trim())
        else reject(new Error(`claude -p exited ${code}: ${err.trim()}`))
      })
    })
  }
}
```

Engine `delegate` replacement (engine gains `private pool = new JobPool(deps.config.jobs.max_parallel)` and imports `appendLog`, `writeFileSync`, `mkdirSync`):

```ts
  private async delegate(ctx: { tasksDir: string; now: Date }, card: string, raw: string): Promise<void> {
    const { caps, registry, config } = this.deps
    const executors = registry.delegate.params?.executor ?? []
    const e = await caps.resolver.decide({
      context: raw,
      question: 'Which executor should produce this?',
      options: executors.map((key) => ({
        key,
        description: key === 'agent' ? 'a coding/reasoning agent on this machine' : 'a local text generation model'
      }))
    })
    if (e.confidence < config.thresholds.action)
      throw new Error(`low confidence on executor (${e.key} ${e.confidence})`)
    const output = await this.pool.run(async () => {
      if (e.key === 'generator') {
        if (!caps.generator) throw new Error('delegate: generator not bound in config')
        return caps.generator.complete(raw)
      }
      if (!caps.agent) throw new Error('delegate: agent not bound in config')
      return caps.agent.run(raw, this.deps.tasksDir)
    })
    const dir = join(ctx.tasksDir, 'artifacts', card)
    mkdirSync(dir, { recursive: true })
    const file = `${ctx.now.toISOString().slice(0, 16).replace(/:/g, '-')}.md`
    writeFileSync(join(dir, file), output)
    appendLog(join(ctx.tasksDir, 'cards', `${card}.md`), 
      `${ctx.now.toISOString().slice(0, 16).replace('T', ' ')} — delegated (${e.key}) → artifacts/${card}/${file}`)
  }
```

- [ ] **Step 4: Run, PASS** — full suite.
- [ ] **Step 5: Commit** — `git commit -am "feat: delegation (job pool, ollama generator, claude agent)"`

---

### Task 11: Ollama resolver

**Files:**
- Modify: `src/main/capabilities/ollama-resolver.ts`
- Test: `src/main/__tests__/ollama-resolver.test.ts`

**Interfaces:**
- Produces: `OllamaResolver implements Resolver`, `constructor(cfg: { host: string; model: string }, fetchImpl?: typeof fetch)`. Calls `POST {host}/api/generate` with `format` set to a JSON schema `{ type: 'object', properties: { key: { type: 'string', enum: [...option keys] }, confidence: { type: 'number' } }, required: ['key','confidence'] }` and a prompt that lists options as `key — description` lines. Parses `response` as JSON; a key outside the enum → throw (never guess).

- [ ] **Step 1: Failing test**

```ts
// src/main/__tests__/ollama-resolver.test.ts
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
      return { ok: true, json: async () => ({ response: '{"key":"update_status","confidence":0.84}' }) }
    }) as unknown as typeof fetch
    const r = new OllamaResolver({ host: 'http://h', model: 'm' }, fetchImpl)
    expect(await r.decide(q)).toEqual({ key: 'update_status', confidence: 0.84 })
  })
  it('throws when the model answers outside the options', async () => {
    const fetchImpl = (async () => ({ ok: true, json: async () => ({ response: '{"key":"nuke","confidence":0.9}' }) })) as unknown as typeof fetch
    const r = new OllamaResolver({ host: 'http://h', model: 'm' }, fetchImpl)
    await expect(r.decide(q)).rejects.toThrow(/nuke/)
  })
})
```

- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement**

```ts
// src/main/capabilities/ollama-resolver.ts
import type { Choice, Resolver } from './contracts'

export class OllamaResolver implements Resolver {
  constructor(
    private cfg: { host: string; model: string },
    private fetchImpl: typeof fetch = fetch
  ) {}

  async decide(q: Choice): Promise<{ key: string; confidence: number }> {
    const keys = q.options.map((o) => o.key)
    const prompt =
      `${q.question}\n\nText: """${q.context}"""\n\nOptions:\n` +
      q.options.map((o) => `- ${o.key} — ${o.description}`).join('\n') +
      `\n\nAnswer with the single best option key and your confidence (0-1).`
    const res = await this.fetchImpl(`${this.cfg.host}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.cfg.model,
        prompt,
        stream: false,
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
```

- [ ] **Step 4: Run, PASS.** **Step 5: Commit** — `git commit -am "feat: ollama resolver (schema-constrained bounded choice)"`

---

### Task 12: Laya resolver

**Files:**
- Modify: `src/main/capabilities/laya-resolver.ts`
- Test: `src/main/__tests__/laya-resolver.test.ts` (unit: loading errors; model behavior is manual)

**Interfaces:**
- Produces: `LayaResolver implements Resolver`, `constructor(cfg: { checkpoint: string })`. Lazy-loads the model on first `decide`; missing checkpoint file → throw `laya checkpoint not found: <path>` (no fallback). Maps `Choice` to Laya's multiple-choice API; returns the chosen option key and Laya's calibrated probability as confidence.

**Before coding:** `npm view @receptron/laya` to confirm the package name (the repo is `github.com/receptron/laya`; if unpublished, `npm i github:receptron/laya`), then read its README for the exact load/choose call names and adapt the two marked lines — the adapter boundary is this file only; the contract and tests don't change.

- [ ] **Step 1: Failing unit test**

```ts
// src/main/__tests__/laya-resolver.test.ts
import { describe, it, expect } from 'vitest'
import { LayaResolver } from '../capabilities/laya-resolver'

describe('LayaResolver', () => {
  it('throws the real error when the checkpoint is missing', async () => {
    const r = new LayaResolver({ checkpoint: '/nope/laya.onnx' })
    await expect(
      r.decide({ context: 'x', question: 'q', options: [{ key: 'a', description: 'a' }] })
    ).rejects.toThrow(/checkpoint not found: \/nope\/laya.onnx/)
  })
})
```

- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement**

```ts
// src/main/capabilities/laya-resolver.ts
import { existsSync } from 'fs'
import type { Choice, Resolver } from './contracts'

export class LayaResolver implements Resolver {
  private model: unknown | null = null
  constructor(private cfg: { checkpoint: string }) {}

  private async load(): Promise<unknown> {
    if (this.model) return this.model
    if (!existsSync(this.cfg.checkpoint))
      throw new Error(`laya checkpoint not found: ${this.cfg.checkpoint}`)
    const { Laya } = await import('@receptron/laya') // ← confirm export name against the package README
    this.model = await Laya.load(this.cfg.checkpoint) // ← confirm load call against the package README
    return this.model
  }

  async decide(q: Choice): Promise<{ key: string; confidence: number }> {
    const model = (await this.load()) as {
      choose(context: string, question: string, options: string[]): Promise<{ index: number; probability: number }>
    }
    const labels = q.options.map((o) => `${o.key}: ${o.description}`)
    const result = await model.choose(q.context, q.question, labels)
    return { key: q.options[result.index].key, confidence: result.probability }
  }
}
```

- [ ] **Step 4: Run unit test, PASS.** Install: `npm i @receptron/laya onnxruntime-node` (adjust per Step-before-coding findings; `electron-builder install-app-deps` picks up the native module). Download a checkpoint into `models/` per the package README, add `models/` to `.gitignore`, and document the two steps plus the `config.json` flip (`"resolver": { "impl": "laya", "checkpoint": "models/<file>.onnx" }`) in a new `docs/laya.md`.
- [ ] **Step 5: Manual verification (requires checkpoint):** temporary script `npx tsx -e` calling `LayaResolver.decide` with the Task 11 fixture; confirm a sane key + confidence. Record actual API names found in `docs/laya.md`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: laya resolver behind the Resolver contract"`

---

### Task 13: Server — API, SSE, static surfaces, MCP

**Files:**
- Create: `src/main/server.ts`
- Test: `src/main/__tests__/server.test.ts`
- Modify: `src/main/index.ts` (wire engine + server), `workspace/.mcp.json` (new file registering the MCP endpoint for external agents)

**Interfaces:**
- Consumes: `Engine`, `readSnapshot`, `writeInstruction`.
- Produces: `startServer(opts: { tasksDir: string; engine: Engine; surfacesDir: string; screenshot: () => Promise<string>; port?: number }): Promise<{ broadcast: () => void; close: () => Promise<void> }>`. Port: `Number(process.env.XWEB_MCP_PORT) || 7920`, bound to 127.0.0.1. Routes:
  - `GET /api/state` → JSON Snapshot
  - `GET /api/events` → SSE; each broadcast sends `data: <json snapshot>\n\n`; client set cleaned on close
  - `POST /api/instructions` `{text}` → `writeInstruction`, 201 `{id}` (engine's queue watcher picks it up)
  - `POST /api/instructions/:id` `{action: 'confirm'|'reject'|'requeue'|'delete', text?}` → engine.confirm/reject/requeue; `delete` removes the file; 200 `{ok:true}`; unknown id/action → 400 with message
  - `POST /api/cards/:shortname` `{description}` → rewrite card body (via readCard/writeCard); `{action:'delete'}` → appends instruction `delete #<shortname>` to the queue (routes through the destructive gate — the API has no privileged side door)
  - `GET /feed`, `GET /board` (+ `.css`/`.js` under those paths) → static files from `surfacesDir`
  - `GET /sse` + `POST /messages` → MCP (same per-connection-server pattern as the old `mcp/server.ts`: fresh `McpServer` per SSE connection); tools: `task` (`{instruction: string}` → same as `POST /api/instructions`), `screenshot` (returns image content from the `screenshot` callback)
- `src/main/index.ts` boot: `resolveTasksDir` → `loadConfig`/`loadRegistry` → `bindCapabilities` → `new Engine({... onChange: () => broadcast()})` → `startServer` → `engine.start()` → create window + views. Any startup throw → `dialog.showErrorBox` with the real error, then quit. (No feed banner at this stage — the feed can't render if the server never started; the dialog is the surface.)
- `workspace/.mcp.json`: `{ "mcpServers": { "taskdeck": { "type": "sse", "url": "http://127.0.0.1:7920/sse" } } }`

- [ ] **Step 1: Failing tests** (run the server on port 0 — have `startServer` return the actual port for tests)

```ts
// src/main/__tests__/server.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startServer } from '../server'
import { writeCard, readInstruction } from '../tasks/files'
import { readSnapshot } from '../tasks/snapshot'

let base: string
let close: () => Promise<void>
let tasksDir: string

const fakeEngine = {
  confirm: async () => undefined,
  reject: () => undefined,
  requeue: () => undefined
} as never

beforeAll(async () => {
  tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const s of ['queue', 'cards', 'artifacts']) mkdirSync(join(tasksDir, s), { recursive: true })
  const surfacesDir = mkdtempSync(join(tmpdir(), 'surf-'))
  mkdirSync(join(surfacesDir, 'feed'))
  writeFileSync(join(surfacesDir, 'feed', 'index.html'), '<html>feed</html>')
  const server = await startServer({
    tasksDir, engine: fakeEngine, surfacesDir,
    screenshot: async () => 'base64png', port: 0
  })
  base = `http://127.0.0.1:${server.port}`
  close = server.close
})
afterAll(async () => close())

describe('api', () => {
  it('POST /api/instructions writes a queue file', async () => {
    const res = await fetch(`${base}/api/instructions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello world task' })
    })
    expect(res.status).toBe(201)
    const { id } = await res.json()
    expect(readInstruction(join(tasksDir, 'queue', `${id}.md`)).raw).toBe('hello world task')
  })
  it('GET /api/state returns the snapshot', async () => {
    writeCard(tasksDir, { shortname: 'c1', title: 'C1', status: 'inbox', created: '2026-10-01', links: [], labels: [], description: '', log: [] })
    const snap = await (await fetch(`${base}/api/state`)).json()
    expect(snap.cards.map((c: { shortname: string }) => c.shortname)).toContain('c1')
  })
  it('card delete routes through the queue, not a side door', async () => {
    const res = await fetch(`${base}/api/cards/c1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete' })
    })
    expect(res.status).toBe(200)
    const snap = readSnapshot(tasksDir)
    expect(snap.instructions.some((i) => i.raw === 'delete #c1')).toBe(true)
  })
  it('serves the feed surface', async () => {
    expect(await (await fetch(`${base}/feed/`)).text()).toContain('feed')
  })
  it('rejects unknown instruction actions with 400', async () => {
    const res = await fetch(`${base}/api/instructions/xyz`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'explode' })
    })
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement `server.ts`** — single `http.createServer` with a route table; SSE clients in a `Set<ServerResponse>`; `broadcast()` serializes `readSnapshot(tasksDir)` once and writes to every client; static handler maps `/feed/*`→`surfacesDir/feed/*` with content types for html/css/js and `index.html` default; MCP section ports the per-connection `buildServer()` pattern from the pre-strip `src/main/mcp/server.ts` (read it from git history: `git show 0950b3e:src/main/mcp/server.ts`) with only the two tools. Return `{ port, broadcast, close }` where `port` is from `server.address()`.
- [ ] **Step 4: Run, PASS** — full suite.
- [ ] **Step 5: Wire boot in `src/main/index.ts`** per the Interfaces block (surfacesDir: `join(app.getAppPath(), 'surfaces')` in dev; keep it an explicit constant). Add `workspace/.mcp.json`. Run `npm run dev`: window opens; `curl -s localhost:7920/api/state` returns JSON; `curl -X POST localhost:7920/api/instructions -H 'Content-Type: application/json' -d '{"text":"write the ngo proposal this wed"}'` → with Ollama running, a card file appears in `workspace/tasks/cards/`.
- [ ] **Step 6: Commit** — `git add -A && git commit -m "feat: taskdeck server (api, sse, surfaces, mcp) and boot wiring"`

---

### Task 14: Feed surface

**Files:**
- Create: `surfaces/feed/index.html`, `surfaces/feed/feed.css`, `surfaces/feed/feed.js`

**Interfaces:**
- Consumes: `/api/events`, `/api/state`, `POST /api/instructions`, `POST /api/instructions/:id`.
- Produces: the left surface. Plain ES modules, no build step, no framework.

- [ ] **Step 1: Write the three files**

`index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>taskdeck — feed</title>
  <link rel="stylesheet" href="/feed/feed.css" />
</head>
<body>
  <section id="done" class="done-section"></section>
  <section id="rows"></section>
  <form id="prompt">
    <span class="chevron">›</span>
    <input id="input" autocomplete="off" autofocus placeholder="type an instruction — #card links, 'clean' sweeps" />
    <div id="complete" hidden></div>
  </form>
  <script type="module" src="/feed/feed.js"></script>
</body>
</html>
```

`feed.js` (complete file):

```js
const rows = document.getElementById('rows')
const done = document.getElementById('done')
const input = document.getElementById('input')
const form = document.getElementById('prompt')
const complete = document.getElementById('complete')

let cards = []

function post(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

function rowActions(inst) {
  if (inst.status === 'needs_confirmation')
    return `<button data-act="confirm">confirm</button><button data-act="reject">reject</button>`
  if (inst.status === 'attention')
    return `<button data-act="edit">edit</button><button data-act="delete">delete</button>`
  return ''
}

function render(snapshot) {
  cards = snapshot.cards
  const open = snapshot.instructions.filter((i) => i.status !== 'done')
  const finished = snapshot.instructions.filter((i) => i.status === 'done')
  rows.innerHTML = open
    .map(
      (i) => `
    <div class="row ${i.status}" data-id="${i.id}">
      <span class="dot"></span>
      <span class="raw">${i.raw}</span>
      <span class="meta">${i.error ?? i.action ?? ''}</span>
      <span class="actions">${rowActions(i)}</span>
    </div>`
    )
    .join('')
  done.innerHTML =
    finished.length === 0
      ? ''
      : `<div class="done-head">${finished.length} done — type "clean" to sweep</div>` +
        finished.map((i) => `<div class="row done"><span class="raw">${i.raw}</span></div>`).join('')
}

rows.addEventListener('click', async (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  const id = e.target.closest('.row').dataset.id
  const act = btn.dataset.act
  if (act === 'edit') {
    const row = e.target.closest('.row')
    const text = prompt('edit instruction', row.querySelector('.raw').textContent)
    if (text) await post(`/api/instructions/${id}`, { action: 'requeue', text })
    return
  }
  await post(`/api/instructions/${id}`, { action: act })
})

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  await post('/api/instructions', { text })
})

// #shortname autocompletion
input.addEventListener('input', () => {
  const m = input.value.match(/#([a-z0-9-]*)$/i)
  if (!m) {
    complete.hidden = true
    return
  }
  const hits = cards.filter((c) => c.shortname.startsWith(m[1].toLowerCase())).slice(0, 6)
  complete.hidden = hits.length === 0
  complete.innerHTML = hits
    .map((c) => `<div class="hit" data-s="${c.shortname}">#${c.shortname} <em>${c.title}</em></div>`)
    .join('')
})
complete.addEventListener('mousedown', (e) => {
  const hit = e.target.closest('.hit')
  if (!hit) return
  input.value = input.value.replace(/#[a-z0-9-]*$/i, `#${hit.dataset.s} `)
  complete.hidden = true
  input.focus()
})

const events = new EventSource('/api/events')
events.onmessage = (e) => render(JSON.parse(e.data))
fetch('/api/state').then((r) => r.json()).then(render)
```

`feed.css` (complete file — dark, terminal-tight, transitions carry the states):

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; }
body {
  background: #0f0f1a; color: #d4d4d8;
  font: 13px/1.5 Menlo, Monaco, monospace;
  display: flex; flex-direction: column;
}
#done { overflow-y: auto; }
.done-head { padding: 6px 12px; color: #55555f; font-size: 11px; }
#rows { flex: 1; overflow-y: auto; display: flex; flex-direction: column; justify-content: flex-end; }
.row {
  display: flex; align-items: center; gap: 10px; padding: 7px 12px;
  border-bottom: 1px solid #1a1a28; transition: background 0.3s, opacity 0.4s;
}
.row .raw { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row .meta { color: #6a6a78; font-size: 11px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: #3a3a48; flex: none; }
.row.working .dot { background: #e8c35a; animation: glow 1.1s ease-in-out infinite alternate; }
@keyframes glow { from { box-shadow: 0 0 2px #e8c35a; } to { box-shadow: 0 0 10px 2px #e8c35a; } }
.row.attention { background: #2a1620; }
.row.attention .dot { background: #ff5d7a; }
.row.attention .meta { color: #ff5d7a; }
.row.needs_confirmation { background: #241f10; }
.row.needs_confirmation .dot { background: #e8c35a; }
.row.done { opacity: 0.45; }
.row.done .dot { background: #3dd68c; }
button {
  background: none; border: 1px solid #3a3a48; color: #d4d4d8;
  font: inherit; font-size: 11px; padding: 2px 9px; border-radius: 4px; cursor: pointer;
}
button:hover { border-color: #6a6a78; }
#prompt {
  display: flex; align-items: center; gap: 8px; padding: 10px 12px;
  border-top: 1px solid #2a2a38; position: relative;
}
.chevron { color: #3dd68c; }
#input { flex: 1; background: none; border: none; outline: none; color: #d4d4d8; font: inherit; }
#complete {
  position: absolute; bottom: 100%; left: 24px; background: #1a1a28;
  border: 1px solid #2a2a38; border-radius: 6px; overflow: hidden;
}
.hit { padding: 5px 12px; cursor: pointer; }
.hit:hover { background: #26263a; }
.hit em { color: #6a6a78; font-style: normal; margin-left: 8px; }
```

- [ ] **Step 2: Manual verification** — `npm run dev`, open `http://127.0.0.1:7920/feed/` in a normal browser. Type an instruction → row appears glowing, then done (Ollama running) or attention (Ollama down — error must name the real failure). Type `#` → completion pops once a card exists. `clean` sweeps. Confirm/reject appear for `delete #<card>`.
- [ ] **Step 3: Commit** — `git add surfaces && git commit -m "feat: feed surface"`

---

### Task 15: Board surface

**Files:**
- Create: `surfaces/board/index.html`, `surfaces/board/board.css`, `surfaces/board/board.js`

**Interfaces:**
- Consumes: `/api/events`, `/api/state`, `POST /api/cards/:shortname`.
- Produces: the right surface: five fixed columns; card click → detail overlay (description editable, log, artifacts list, delete).

- [ ] **Step 1: Write the three files**

`index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>taskdeck — board</title>
  <link rel="stylesheet" href="/board/board.css" />
</head>
<body>
  <main id="board"></main>
  <div id="overlay" hidden>
    <div id="detail"></div>
  </div>
  <script type="module" src="/board/board.js"></script>
</body>
</html>
```

`board.js` (complete file):

```js
const COLUMNS = ['inbox', 'active', 'waiting', 'done', 'dropped']
const board = document.getElementById('board')
const overlay = document.getElementById('overlay')
const detail = document.getElementById('detail')

let snapshot = { cards: [] }

function cardHtml(c) {
  return `
  <div class="card" data-s="${c.shortname}">
    <div class="title">${c.title}</div>
    <div class="chips">
      <span class="chip name">#${c.shortname}</span>
      ${c.due ? `<span class="chip due">${c.due}</span>` : ''}
      ${c.labels.map((l) => `<span class="chip">${l}</span>`).join('')}
      ${c.links.map((l) => `<span class="chip link">#${l}</span>`).join('')}
    </div>
  </div>`
}

function positions() {
  const map = new Map()
  for (const el of board.querySelectorAll('.card')) map.set(el.dataset.s, el.getBoundingClientRect())
  return map
}

function render() {
  const before = positions()
  board.innerHTML = COLUMNS.map(
    (col) => `
    <section class="col">
      <h2>${col} <span>${snapshot.cards.filter((c) => c.status === col).length}</span></h2>
      ${snapshot.cards.filter((c) => c.status === col).map(cardHtml).join('')}
    </section>`
  ).join('')
  // FLIP: animate cards that moved
  for (const el of board.querySelectorAll('.card')) {
    const prev = before.get(el.dataset.s)
    if (!prev) continue
    const now = el.getBoundingClientRect()
    const dx = prev.left - now.left
    const dy = prev.top - now.top
    if (dx || dy) {
      el.animate(
        [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
        { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      )
    }
  }
}

board.addEventListener('click', (e) => {
  const el = e.target.closest('.card')
  if (!el) return
  const c = snapshot.cards.find((x) => x.shortname === el.dataset.s)
  detail.innerHTML = `
    <h1>${c.title}</h1>
    <div class="chips"><span class="chip name">#${c.shortname}</span>
      <span class="chip">${c.status}</span>${c.due ? `<span class="chip due">${c.due}</span>` : ''}</div>
    <textarea id="desc">${c.description}</textarea>
    <div class="log">${c.log.map((l) => `<div>${l}</div>`).join('')}</div>
    <div class="buttons">
      <button id="save">save</button>
      <button id="del" class="danger">delete</button>
      <button id="close">close</button>
    </div>`
  overlay.hidden = false
  document.getElementById('close').onclick = () => (overlay.hidden = true)
  document.getElementById('save').onclick = async () => {
    await fetch(`/api/cards/${c.shortname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ description: document.getElementById('desc').value })
    })
    overlay.hidden = true
  }
  document.getElementById('del').onclick = async () => {
    await fetch(`/api/cards/${c.shortname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete' })
    })
    overlay.hidden = true // confirmation happens in the feed — destructive gate
  }
})
overlay.addEventListener('click', (e) => {
  if (e.target === overlay) overlay.hidden = true
})

const events = new EventSource('/api/events')
events.onmessage = (e) => {
  snapshot = JSON.parse(e.data)
  render()
}
fetch('/api/state').then((r) => r.json()).then((s) => { snapshot = s; render() })
```

`board.css` (complete file):

```css
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; }
body { background: #13131e; color: #d4d4d8; font: 13px/1.5 -apple-system, 'Helvetica Neue', sans-serif; }
#board { display: grid; grid-template-columns: repeat(5, 1fr); gap: 1px; height: 100%; background: #1f1f2e; }
.col { background: #13131e; padding: 10px; overflow-y: auto; }
.col h2 { font-size: 11px; text-transform: uppercase; letter-spacing: 0.1em; color: #6a6a78; margin-bottom: 10px; }
.col h2 span { color: #3a3a48; }
.card {
  background: #1b1b2a; border: 1px solid #26263a; border-radius: 8px;
  padding: 10px 12px; margin-bottom: 8px; cursor: pointer; transition: border-color 0.2s;
}
.card:hover { border-color: #4a4a68; }
.card .title { font-size: 13px; margin-bottom: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 4px; }
.chip {
  font: 10px/1 Menlo, monospace; color: #8a8a98; background: #22223200;
  border: 1px solid #2e2e42; border-radius: 999px; padding: 3px 7px;
}
.chip.name { color: #7aa2f7; border-color: #2a3a5e; }
.chip.due { color: #e8c35a; border-color: #4a3f1e; }
.chip.link { color: #3dd68c; border-color: #1e4a35; }
#overlay { position: fixed; inset: 0; background: rgba(8, 8, 14, 0.7); display: flex; align-items: center; justify-content: center; }
#detail { width: min(560px, 90vw); max-height: 80vh; overflow-y: auto; background: #1b1b2a; border: 1px solid #2e2e42; border-radius: 12px; padding: 24px; }
#detail h1 { font-size: 17px; margin-bottom: 10px; }
#detail textarea {
  width: 100%; min-height: 90px; margin: 14px 0; background: #13131e; color: #d4d4d8;
  border: 1px solid #2e2e42; border-radius: 8px; padding: 10px; font: inherit; resize: vertical;
}
.log { font: 11px/1.8 Menlo, monospace; color: #8a8a98; border-top: 1px solid #26263a; padding-top: 10px; }
.buttons { display: flex; gap: 8px; margin-top: 16px; }
button { background: #26263a; border: 1px solid #2e2e42; color: #d4d4d8; font: inherit; font-size: 12px; padding: 6px 14px; border-radius: 6px; cursor: pointer; }
button.danger { border-color: #5e2a3a; color: #ff5d7a; }
```

- [ ] **Step 2: Manual verification** — with the dev server up: create a few cards from the feed; the board shows them in `inbox`; "proposal got declined"-style update moves one (FLIP animates); click card → edit description → file on disk changes; hand-edit a card file in an editor → board updates within a second; delete from detail → confirmation appears in the feed.
- [ ] **Step 3: Commit** — `git add surfaces && git commit -m "feat: board surface"`

---

### Task 16: Electron shell — two views, divider, screenshot

**Files:**
- Create: `src/main/views.ts`
- Modify: `src/main/index.ts`, `src/main/ipc-handlers.ts`, `src/renderer/src/main.ts`, `src/renderer/index.html`

**Interfaces:**
- Produces:

```ts
// views.ts
export class SurfaceViews {
  constructor(window: BrowserWindow, baseUrl: string) // creates two WebContentsViews: feed → {baseUrl}/feed/, board → {baseUrl}/board/
  setRegions(regions: LayoutRegions): void
  screenshotBoard(): Promise<string>                  // capturePage → base64 PNG; also saves to SCREENSHOT_DIR like the old browser-views did
}
```

- Renderer: a page that is only a vertical divider at `--split` (default 42%), draggable; on drag/resize it computes the two regions (left of divider = feed, right = board) and calls `window.taskdeck.sendRegions(regions)`. `ipc-handlers.ts` forwards `IPC.REGIONS` to `SurfaceViews.setRegions`. MCP `screenshot` tool and `startServer`'s `screenshot` callback both use `screenshotBoard`.

- [ ] **Step 1: Implement `views.ts`**

```ts
// src/main/views.ts
import { BrowserWindow, WebContentsView } from 'electron'
import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { SCREENSHOT_DIR } from './screenshot-cleanup'
import type { LayoutRegions } from '../shared/types'

export class SurfaceViews {
  private feed: WebContentsView
  private board: WebContentsView

  constructor(window: BrowserWindow, baseUrl: string) {
    this.feed = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    this.board = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true } })
    window.contentView.addChildView(this.feed)
    window.contentView.addChildView(this.board)
    this.feed.webContents.loadURL(`${baseUrl}/feed/`)
    this.board.webContents.loadURL(`${baseUrl}/board/`)
  }

  setRegions(regions: LayoutRegions): void {
    this.feed.setBounds(regions.feed)
    this.board.setBounds(regions.board)
  }

  async screenshotBoard(): Promise<string> {
    const image = await this.board.webContents.capturePage()
    await mkdir(SCREENSHOT_DIR, { recursive: true })
    await writeFile(join(SCREENSHOT_DIR, `screenshot-${Date.now()}.png`), image.toPNG())
    return image.toPNG().toString('base64')
  }
}
```

- [ ] **Step 2: Renderer divider** — `src/renderer/index.html` body: `<div id="divider"></div>` + dark background CSS; `src/renderer/src/main.ts`:

```ts
const divider = document.getElementById('divider')!
let split = 0.42
let dragging = false

function report(): void {
  const { innerWidth: w, innerHeight: h } = window
  const x = Math.round(w * split)
  divider.style.left = `${x - 2}px`
  window.taskdeck.sendRegions({
    feed: { x: 0, y: 0, width: x - 2, height: h },
    board: { x: x + 2, y: 0, width: w - x - 2, height: h }
  })
}
divider.addEventListener('mousedown', () => (dragging = true))
window.addEventListener('mouseup', () => (dragging = false))
window.addEventListener('mousemove', (e) => {
  if (!dragging) return
  split = Math.min(0.8, Math.max(0.2, e.clientX / window.innerWidth))
  report()
})
window.addEventListener('resize', report)
report()
```

(Divider CSS: `position: fixed; top: 0; bottom: 0; width: 4px; cursor: col-resize; background: #2a2a38;`.)

- [ ] **Step 3: Wire `index.ts` and `ipc-handlers.ts`** — after `startServer` resolves: `const views = new SurfaceViews(mainWindow, 'http://127.0.0.1:7920')`; pass `views.screenshotBoard` into `startServer` (construct views first, then server — reorder so the callback exists; simplest: create window+views, then `startServer({ screenshot: () => views.screenshotBoard(), ... })`, then `engine.start()`). `setupIpcHandlers(window, views)` registers `ipcMain.on(IPC.REGIONS, (_, r) => views.setRegions(r))` with a destroyed-window guard.
- [ ] **Step 4: Manual verification (full first-run)** — `npm run dev`: window opens with feed left, board right; divider drags; type "gotta write the ngo proposal this wed" → glow → card appears on board with due `2026-10-07`; "proposal got declined" after creating a proposal card → status moves with animation; `delete #<card>` → confirm in feed; kill Ollama → new instruction goes attention with the connection error verbatim; hand-edit a card file → board updates. `npm run typecheck && npx eslint . && npx vitest run` all green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat: electron shell hosts feed+board surfaces with divider and board screenshot"`

---

### Task 17: Docs + close out

**Files:**
- Modify: `CLAUDE.md`, `README.md`
- Create: `docs/specs/2026-10-02-taskdeck-design.md` → update Status line to `implemented (prototype)` and fill a short **Learnings** subsection under "What we want to learn" as discovered during Tasks 13–16.

- [ ] **Step 1: Rewrite `CLAUDE.md`** for the branch: what taskdeck is, the three layers (data `workspace/tasks/`, surfaces `/feed` `/board`, capabilities + config bindings), dev commands (unchanged), the no-fallbacks rule, MCP tools (`task`, `screenshot`), env vars (`XWEB_WORKSPACE`, `XWEB_MCP_PORT`).
- [ ] **Step 2: Rewrite `README.md`** quick start: `npm install`, install Ollama + `ollama pull qwen3:4b` (or flip config to laya per `docs/laya.md`), `npm run dev`, type your first instruction. Screenshot placeholder for later.
- [ ] **Step 3: Full verification** — `npm run typecheck && npx eslint . && npx vitest run && npm run build`.
- [ ] **Step 4: Commit** — `git add -A && git commit -m "docs: taskdeck branch docs and spec learnings"`

---

## Self-Review (done at planning time)

- **Spec coverage:** data layout (T2–T4), registry+classes (T2, T9), engine pipeline/FIFO/freeze/confirmation (T9), capabilities+no-fallbacks (T5, T10–T12), delegation (T10), one API + SSE + MCP (T13), dumb surfaces with transitions and `#` autocomplete (T14–T15), shell/divider/screenshot (T16), removals (T1), docs (T17). Confirmation timeout: armed in T9, test uses 1s config — covered by the reject path; timeout fire itself is exercised manually in T16 Step 4 if desired.
- **Placeholders:** none; the two Laya adapter lines are explicitly marked verification points against an external package README, with the contract boundary isolating them.
- **Type consistency:** `Instruction`/`Card`/`Snapshot`/`Registry`/`TaskdeckConfig` defined once in T2 and imported everywhere; handler signatures in T8 match T9's `execute`; `startServer` options in T13 match T16 wiring; `LayoutRegions` defined in T1 and used in T16.
