// src/main/tasks/engine.ts
import { watch, FSWatcher } from 'chokidar'
import {
  readdirSync,
  rmSync,
  existsSync,
  mkdirSync,
  renameSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  statSync
} from 'fs'
import { join } from 'path'
import matter from 'gray-matter'
import {
  readInstruction,
  patchInstruction,
  writeInstruction,
  appendLog,
  readCard,
  writeCard,
  writeFileAtomic
} from './files'
import { validateCard, validateInstruction, validateElement, formatErrors } from './validate'
import { loadElements, BUNDLED } from './elements/registry'
import { applyOp } from './elements/ops'
import { readSnapshot } from './snapshot'
import { prepass } from './prepass'
import { diffCard, type CardFacts } from './reconcile'
import { resolveCardRef } from './resolve'
import {
  handleCreate,
  handleUpdateStatus,
  handleNote,
  handleLink,
  handleDelete,
  handleLabel,
  handleUnlabel,
  handleRename,
  handleReslug,
  handleDescribe
} from './handlers'
import { parseCommand } from './cli'
import { buildDelegationContext } from './context'
import type {
  Instruction,
  Registry,
  TaskdeckConfig,
  CardStatus,
  RegistryAliases,
  ProjectOps,
  Scope
} from './types'
import type { Capabilities } from '../capabilities/contracts'
import { JobPool } from './jobs'
type ExecuteOpts = {
  title?: string
  desc?: string
  tags?: string[]
  due?: string
  with?: string
  scope?: Scope
  card2?: string
}

export interface EngineDeps {
  tasksDir: string
  device: string // this machine's id — see claim()
  registry: Registry
  config: TaskdeckConfig
  caps: Capabilities
  aliases: RegistryAliases
  onChange: () => void
  projects?: ProjectOps
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
  private pool: JobPool
  private cardFacts = new Map<string, CardFacts>()
  private startedAt = new Map<string, number>()
  private doneAt = new Map<string, number>()
  private sweepTimer?: ReturnType<typeof setInterval>
  private fsSigs = new Map<string, string>()
  private fsSweepTimer?: ReturnType<typeof setInterval>
  // Transient UI nav: an `open #card` publishes a card for the board to expand,
  // delivered in the snapshot. A monotonic seq lets the board act exactly once.
  private navState?: { card: string; seq: number }
  private navSeq = 0
  // The card currently open on the board (device-local UI state, set by the
  // surfaces on open/click/close). Surfaced in the snapshot so the feed can
  // target it when a card-verb is typed without a #ref. Lives only in memory —
  // a new engine (project switch) starts with nothing open.
  private openCardName?: string

  constructor(deps: EngineDeps) {
    this.deps = deps
    this.pool = new JobPool(deps.config.jobs.max_parallel)
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
    // crash recovery: working → queued; re-derive frozen/confirmation state from files
    for (const f of readdirSync(this.queueDir()).filter((n) => n.endsWith('.md'))) {
      const p = join(this.queueDir(), f)
      try {
        const inst = readInstruction(p)
        if (!this.claim(p, inst)) continue
        if (inst.status === 'working') {
          patchInstruction(p, { status: 'queued' })
        } else if (inst.status === 'attention') {
          // Re-derive frozen set: freeze the card from frontmatter and any #refs in body
          if (inst.card) this.frozen.add(inst.card)
          for (const m of inst.raw.matchAll(/#([a-z0-9-]+)/gi)) this.frozen.add(m[1].toLowerCase())
        } else if (inst.status === 'needs_confirmation') {
          // Revert to queued — chokidar add will reprocess through the pipeline,
          // re-parking as needs_confirmation with a fresh timer
          patchInstruction(p, { status: 'queued' })
        }
      } catch (err) {
        console.error('engine boot: skipping unparseable', f, err)
      }
    }
    // Process all currently-queued files immediately (handles reverted needs_confirmation files
    // and any queued files that may have been written before start() was called).
    // Chokidar's ignoreInitial:true means add events are NOT fired for pre-existing files;
    // by processing synchronously here we guarantee drain() can await them.
    for (const f of readdirSync(this.queueDir()).filter((n) => n.endsWith('.md'))) {
      const p = join(this.queueDir(), f)
      try {
        if (readInstruction(p).status === 'queued') this.track(this.processFile(p))
      } catch {
        /* skip */
      }
    }
    const q = watch(this.queueDir(), { ignoreInitial: true, depth: 0 })
    q.on('add', (p) => this.track(this.processFile(p)))
    q.on('change', () => this.deps.onChange())
    q.on('unlink', () => this.deps.onChange())
    this.refreshCardFacts()
    const c = watch(join(this.deps.tasksDir, 'cards'), { ignoreInitial: true, depth: 0 })
    c.on('add', (p) => {
      this.reconcileCard(p)
      this.deps.onChange()
    })
    c.on('change', (p) => {
      this.reconcileCard(p)
      this.deps.onChange()
    })
    c.on('unlink', (p) => {
      this.cardFacts.delete(p)
      this.deps.onChange()
    })
    this.watchers = [q, c]
    // This device's pre-existing done rows start their TTL at boot.
    for (const f of readdirSync(this.queueDir()).filter((n) => n.endsWith('.md'))) {
      const p = join(this.queueDir(), f)
      try {
        const inst = readInstruction(p)
        if (inst.status === 'done' && inst.device === this.deps.device)
          this.doneAt.set(p, this.now().getTime())
      } catch {
        /* skip */
      }
    }
    if (this.deps.config.done_ttl_s) this.sweepTimer = setInterval(() => this.sweepDone(), 5000)
    // Polling backstop for the chokidar watchers above: sync tools (Syncthing)
    // replace files via tmp-write + rename and preserve the remote mtime — a
    // pattern macOS fsevents intermittently drops, leaving the UI stale until
    // restart. Baseline every file's identity now, then stat-sweep both dirs and
    // reconcile whatever moved. The dirs are small; a sweep is a few stats.
    this.seedFsSigs()
    this.fsSweepTimer = setInterval(() => this.sweepFs(), 2000)
  }

  private fsSig(path: string): string | undefined {
    try {
      const s = statSync(path)
      return `${s.mtimeMs}:${s.size}:${s.ino}`
    } catch {
      return undefined // vanished mid-sweep; the unlink pass picks it up
    }
  }

  private seedFsSigs(): void {
    this.fsSigs.clear()
    for (const dir of [this.queueDir(), join(this.deps.tasksDir, 'cards')]) {
      let names: string[]
      try {
        names = readdirSync(dir).filter((n) => n.endsWith('.md'))
      } catch {
        continue
      }
      for (const n of names) {
        const p = join(dir, n)
        const sig = this.fsSig(p)
        if (sig) this.fsSigs.set(p, sig)
      }
    }
  }

  private sweepFs(): void {
    const cardsDir = join(this.deps.tasksDir, 'cards')
    let changed = false
    const seen = new Set<string>()
    for (const dir of [this.queueDir(), cardsDir]) {
      let names: string[]
      try {
        names = readdirSync(dir).filter((n) => n.endsWith('.md'))
      } catch {
        continue
      }
      for (const n of names) {
        const p = join(dir, n)
        seen.add(p)
        const sig = this.fsSig(p)
        if (!sig || this.fsSigs.get(p) === sig) continue
        this.fsSigs.set(p, sig)
        changed = true
        // Same doors the watcher events use — both are idempotent, so a change
        // chokidar DID catch costs nothing here beyond the stat.
        if (dir === cardsDir) this.reconcileCard(p)
        else this.track(this.processFile(p))
      }
    }
    for (const p of [...this.fsSigs.keys()]) {
      if (seen.has(p)) continue
      this.fsSigs.delete(p)
      this.cardFacts.delete(p)
      changed = true
    }
    if (changed) this.deps.onChange()
  }

  /** Re-read all cards into the known-facts cache — called after engine-driven writes so
   *  the watcher only logs changes that arrived through a direct edit (hand or API). */
  private refreshCardFacts(): void {
    this.cardFacts.clear()
    const dir = join(this.deps.tasksDir, 'cards')
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const p = join(dir, f)
      try {
        const c = readCard(p)
        this.cardFacts.set(p, {
          status: c.status,
          description: c.description,
          title: c.title,
          log: c.log
        })
      } catch {
        /* half-written; watcher fires again on save */
      }
    }
  }

  /** Hand edits are first-class ops: log what a direct edit changed, then absorb it. */
  private reconcileCard(path: string): void {
    if (!path.endsWith('.md')) return
    let card
    try {
      card = readCard(path)
    } catch {
      return // half-written hand edit; watcher fires again on save
    }
    const next = {
      status: card.status,
      description: card.description,
      title: card.title,
      log: card.log
    }
    const changes = diffCard(this.cardFacts.get(path), next)
    this.cardFacts.set(path, next)
    const stamp = this.now().toISOString().slice(0, 16).replace('T', ' ')
    for (const change of changes) appendLog(path, `${stamp} — ${change}`)
  }

  async stop(): Promise<void> {
    for (const w of this.watchers) await w.close()
    for (const p of this.pendingConfirm.values()) clearTimeout(p.timer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    if (this.fsSweepTimer) clearInterval(this.fsSweepTimer)
  }

  /** Latest transient UI nav request (an `open #card`), for the snapshot. */
  getNav(): { card: string; seq: number } | undefined {
    return this.navState
  }

  /** The card currently open on the board (for the snapshot), or undefined. */
  getOpenCard(): string | undefined {
    return this.openCardName
  }

  /** Surfaces report their open/closed card here; broadcasts so the feed updates. */
  setOpenCard(card: string | null): void {
    this.openCardName = card ?? undefined
    this.deps.onChange()
  }

  /**
   * Apply a declarative element op to a card's content (the surfaces' edit path).
   * Reads the card, runs the pure `applyOp` (which throws on an undeclared op or a
   * missing id), writes the result, logs the change, and broadcasts. `note.add`
   * is stamped with the current time here — the surface only sends the text.
   */
  applyElementOp(
    shortname: string,
    type: string,
    op: string,
    args: { id?: string; text?: string }
  ): Promise<void> {
    // Serialize on the card's chain — the SAME per-card queue instruction
    // processing uses — so a user edit and an in-flight instruction (e.g. a
    // delegation writing an output) never read-modify-write over each other.
    const run = async (): Promise<void> => {
      const path = join(this.deps.tasksDir, 'cards', `${shortname}.md`)
      if (!existsSync(path)) throw new Error(`card not found: ${shortname}`)
      const card = readCard(path)
      const stamp = this.now().toISOString().slice(0, 16).replace('T', ' ')
      // A drop is recoverable: tuck the element into .trash before applyOp removes
      // it, so restoreLastDrop can bring it back with its id + content intact.
      if (op === 'drop') {
        const dropped = card.elements.find((e) => e.id === args.id)
        if (dropped) this.trashRecord(shortname, { ts: stamp, kind: 'element', element: dropped })
      }
      const fullArgs = op === 'add' ? { ...args, at: stamp } : args
      const elements = applyOp(card.elements, type, op, fullArgs, BUNDLED)
      writeCard(this.deps.tasksDir, { ...card, elements })
      appendLog(path, `${stamp} — ${type} ${op}`)
      this.refreshCardFacts()
      this.deps.onChange()
    }
    return this.chain(shortname, run)
  }

  /** Append a recoverable deletion to the card's greppable trash log. */
  private trashRecord(shortname: string, record: object): void {
    const dir = join(this.deps.tasksDir, '.trash')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, `${shortname}.jsonl`), JSON.stringify(record) + '\n')
  }

  /** Drop an output file recoverably: move it into .trash, record it so
   *  restoreLastDrop can move it back, and log it on the card — the same
   *  trash + activity path element drops take. Throws if the file is missing
   *  (fail loud). Serialized on the card's chain. */
  dropOutput(shortname: string, file: string): Promise<void> {
    const run = async (): Promise<void> => {
      const src = join(this.deps.tasksDir, 'artifacts', shortname, file)
      if (!existsSync(src)) throw new Error(`output not found: ${file}`)
      const stamp = this.now().toISOString().slice(0, 16).replace('T', ' ')
      const trashDir = join(this.deps.tasksDir, '.trash', 'artifacts', shortname)
      mkdirSync(trashDir, { recursive: true })
      renameSync(src, join(trashDir, file))
      this.trashRecord(shortname, { ts: stamp, kind: 'output', file })
      const cardPath = join(this.deps.tasksDir, 'cards', `${shortname}.md`)
      if (existsSync(cardPath)) appendLog(cardPath, `${stamp} — output drop (${file})`)
      this.refreshCardFacts()
      this.deps.onChange()
    }
    return this.chain(shortname, run)
  }

  /** Undo the most recent drop on a card — re-insert the element, or move the
   *  output file back from .trash. Serialized on the card's chain. */
  restoreLastDrop(shortname: string): Promise<void> {
    const run = async (): Promise<void> => {
      const trashPath = join(this.deps.tasksDir, '.trash', `${shortname}.jsonl`)
      const lines = existsSync(trashPath)
        ? readFileSync(trashPath, 'utf-8').split('\n').filter(Boolean)
        : []
      if (!lines.length) throw new Error(`nothing to undo for #${shortname}`)
      const last = JSON.parse(lines[lines.length - 1])
      writeFileSync(trashPath, lines.slice(0, -1).map((l) => l + '\n').join(''))
      const stamp = this.now().toISOString().slice(0, 16).replace('T', ' ')
      const cardPath = join(this.deps.tasksDir, 'cards', `${shortname}.md`)
      if (last.kind === 'element' && existsSync(cardPath)) {
        const card = readCard(cardPath)
        writeCard(this.deps.tasksDir, { ...card, elements: [...card.elements, last.element] })
        appendLog(cardPath, `${stamp} — restored ${last.element.type}`)
      } else if (last.kind === 'output') {
        const from = join(this.deps.tasksDir, '.trash', 'artifacts', shortname, last.file)
        if (existsSync(from)) {
          const destDir = join(this.deps.tasksDir, 'artifacts', shortname)
          mkdirSync(destDir, { recursive: true })
          renameSync(from, join(destDir, last.file))
        }
      }
      this.refreshCardFacts()
      this.deps.onChange()
    }
    return this.chain(shortname, run)
  }

  /** Enqueue work on a card's per-card chain (shared with instruction processing)
   *  so reads+writes never interleave; a thrown op doesn't poison the chain. */
  private chain(shortname: string, run: () => Promise<void>): Promise<void> {
    const chained = (this.chains.get(shortname) ?? Promise.resolve()).then(run)
    this.chains.set(
      shortname,
      chained.catch(() => {})
    )
    return chained
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
    if (!this.claim(path, inst)) return
    if (inst.status !== 'queued') return
    this.inflight.add(path)
    try {
      await this.pipeline(path, inst)
    } finally {
      this.inflight.delete(path)
    }
  }

  /** In a synced workspace another machine's instructions arrive as files: they show in
   *  the feed but only their owner runs, recovers or sweeps them. An instruction without a
   *  device (fresh API write, hand-written file, pre-sync data) belongs to the first engine
   *  that sees it — milliseconds after the write, well before any sync tool ships it. */
  private claim(path: string, inst: Instruction): boolean {
    if (inst.device === undefined) {
      patchInstruction(path, { device: this.deps.device })
      return true
    }
    return inst.device === this.deps.device
  }

  private setStatus(path: string, patch: Parameters<typeof patchInstruction>[1]): void {
    patchInstruction(path, patch)
    // Track completion time for the done-TTL sweep (config.done_ttl_s).
    if (patch.status === 'done') this.doneAt.set(path, this.now().getTime())
    else if (patch.status !== undefined) this.doneAt.delete(path)
    this.deps.onChange()
  }

  /** Console hygiene: done rows auto-sweep into history/ after done_ttl_s.
   *  Same motion as `clean`, on a timer — files move, nothing is deleted. */
  sweepDone(): void {
    const ttl = this.deps.config.done_ttl_s
    if (!ttl) return
    const cutoff = this.now().getTime() - ttl * 1000
    const historyDir = join(this.deps.tasksDir, 'history')
    let moved = false
    for (const [path, at] of [...this.doneAt]) {
      if (at > cutoff) continue
      this.doneAt.delete(path)
      if (!existsSync(path)) continue // cleaned/deleted meanwhile
      try {
        if (readInstruction(path).status !== 'done') continue // hand-requeued
        mkdirSync(historyDir, { recursive: true })
        renameSync(path, join(historyDir, path.split('/').pop()!))
        moved = true
      } catch {
        /* half-written; next tick */
      }
    }
    if (moved) this.deps.onChange()
  }

  /** Execution telemetry for a terminal patch: which engine ran the instruction and for
   *  how long. 'cli' is the deterministic layer (including pre-resolved surface actions);
   *  'cli+ai' is the layered path — CLI claimed the verb, the resolver picked the card. */
  private telemetry(
    path: string,
    via: 'cli' | 'cli+ai'
  ): { engine: string; model?: string; version?: string; ms?: number } {
    const started = this.startedAt.get(path)
    const ms = started === undefined ? undefined : this.now().getTime() - started
    if (via === 'cli') return { engine: 'cli', ms }
    const r = this.deps.config.resolver
    const info = this.deps.caps.resolver.info
    return {
      engine: `cli+${r.impl}`,
      model: info?.model ?? (typeof r.model === 'string' ? r.model : undefined),
      version: info?.version,
      ms
    }
  }

  private async pipeline(
    path: string,
    inst: {
      raw: string
      action?: string
      card?: string
      to?: string
      title?: string
      desc?: string
      tags?: string[]
      due?: string
      with?: string
      scope?: Scope
    }
  ): Promise<void> {
    const { tasksDir, registry, config, caps } = this.deps
    const raw = inst.raw
    this.startedAt.set(path, this.now().getTime())
    this.setStatus(path, { status: 'working' })

    const pre = prepass(raw, caps.dates, this.now(), registry)
    if (pre.meta === 'clean') {
      // A console keeps its scrollback: sweep done instructions into history/
      // (telemetry frontmatter and all) instead of deleting them.
      const historyDir = join(tasksDir, 'history')
      mkdirSync(historyDir, { recursive: true })
      for (const f of readdirSync(this.queueDir()).filter((n) => n.endsWith('.md'))) {
        const p = join(this.queueDir(), f)
        try {
          if (p !== path && readInstruction(p).status === 'done') renameSync(p, join(historyDir, f))
        } catch {
          /* skip */
        }
      }
      rmSync(path) // the clean itself leaves no history noise
      this.deps.onChange()
      return
    }
    if (pre.meta === 'clear') {
      // A console's clear: wipe the scrollback — done rows and the history
      // they were swept into. Cards are untouched; this is log hygiene.
      const historyDir = join(tasksDir, 'history')
      mkdirSync(historyDir, { recursive: true })
      for (const f of readdirSync(historyDir).filter((n) => n.endsWith('.md')))
        rmSync(join(historyDir, f))
      for (const f of readdirSync(this.queueDir()).filter((n) => n.endsWith('.md'))) {
        const p = join(this.queueDir(), f)
        try {
          if (p !== path && readInstruction(p).status === 'done') rmSync(p)
        } catch {
          /* skip */
        }
      }
      rmSync(path)
      this.deps.onChange()
      return
    }
    if (pre.meta === 'check') {
      const dirs: Array<[string, (fm: unknown) => ReturnType<typeof validateCard>]> = [
        ['cards', validateCard],
        ['queue', validateInstruction],
        ['history', validateInstruction]
      ]
      let total = 0
      const bad: string[] = []

      // Load element types once — if elements.json is absent, element validation is skipped
      // silently (legacy/migrating project). If the file exists but is malformed, report it.
      let elementTypes: Record<string, { schema: string }> | null = null
      const elementsJsonPath = join(tasksDir, 'elements.json')
      if (existsSync(elementsJsonPath)) {
        try {
          const loaded = loadElements(tasksDir)
          elementTypes = loaded.types
        } catch (err) {
          bad.push(
            `elements.json: unreadable (${err instanceof Error ? err.message : String(err)})`
          )
        }
      }

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

            // For cards, also validate each element's data against its type schema
            if (sub === 'cards' && elementTypes !== null) {
              const card = readCard(join(d, f))
              for (const el of card.elements) {
                const elErrs = validateElement(el.type, el.data, elementTypes)
                if (elErrs.length) {
                  bad.push(`${sub}/${f} element[${el.id}]: ${formatErrors(elErrs)}`)
                }
              }
            }
          } catch (err) {
            bad.push(
              `${sub}/${f}: unreadable (${err instanceof Error ? err.message : String(err)})`
            )
          }
        }
      }
      const result = bad.length
        ? `checked ${total} files — ${bad.length} invalid\n${bad.join('\n')}`
        : `checked ${total} files — all valid`
      this.setStatus(path, { status: 'done', via: 'cli', result, ...this.telemetry(path, 'cli') })
      return
    }

    let resolution: { kind: 'action'; action: string; card?: string; status?: string }
    let cliOpts: ExecuteOpts | undefined
    let hybrid = false // needs-card path: CLI verb + resolver card pick
    if (inst.action) {
      // Pre-resolved by a deterministic surface action (board drop, button): the meaning
      // is already known — a human did it, confidence is absolute. Skip the CLI parser
      // but keep every downstream gate (freeze, destructive confirmation, handlers).
      if (!registry[inst.action]) {
        this.setStatus(path, { status: 'attention', error: `unknown action "${inst.action}"` })
        return
      }
      // Pick up any stored fields from pre-resolved instructions (e.g. CLI-written frontmatter).
      cliOpts = {
        title: inst.title,
        desc: inst.desc,
        tags: inst.tags,
        due: inst.due,
        with: inst.with,
        scope: inst.scope
      }
      resolution = {
        kind: 'action' as const,
        action: inst.action,
        card: inst.card,
        status: inst.to
      }
    } else {
      // CLI layer: attempt to parse the raw instruction as a CLI command; declined input
      // is captured as a card via the create default (no AI resolver consulted).
      const { cards } = readSnapshot(tasksDir)
      const parsed = parseCommand(raw, {
        shortnames: new Set(cards.map((c) => c.shortname)),
        statuses: (registry.update_status?.params?.status ?? []) as string[],
        aliases: this.deps.aliases,
        collaborators: Object.keys(config.collaborators ?? {}),
        highlightLabels: config.ui?.highlight_labels ?? [],
        dates: caps.dates,
        now: this.now(),
        targetPolicy: Object.fromEntries(
          Object.entries(registry).map(([k, v]) => [k, v.target ?? 'required'])
        ),
        openCard: this.openCardName
      })

      if (parsed.kind === 'error') {
        // Command grammar failure (bare or slash-forced) — park in attention with the parse error.
        this.setStatus(path, {
          status: 'attention',
          error: parsed.error,
          ...this.telemetry(path, 'cli')
        })
        return
      }

      if (parsed.kind === 'project') {
        const ops = this.deps.projects
        if (!ops) {
          this.setStatus(path, {
            status: 'attention',
            error: 'project operations not available',
            ...this.telemetry(path, 'cli')
          })
          return
        }
        const p = parsed.project
        try {
          if (p.op === 'list') {
            const cur = ops.current()
            const lines = ops.list().map((n) => (n === cur ? `* ${n}` : `  ${n}`))
            const tpl = ops.templates()
            this.setStatus(path, {
              status: 'done',
              via: 'cli',
              action: 'project',
              result: lines.join('\n') + (tpl.length ? `\ntemplates: ${tpl.join(', ')}` : ''),
              ...this.telemetry(path, 'cli')
            })
          } else if (p.op === 'switch') {
            await ops.switch(p.name)
            this.setStatus(path, {
              status: 'done',
              via: 'cli',
              action: 'project',
              result: `→ ${p.name}`,
              ...this.telemetry(path, 'cli')
            })
          } else if (p.op === 'new') {
            await ops.create(p.name, p.template)
            await ops.switch(p.name)
            this.setStatus(path, {
              status: 'done',
              via: 'cli',
              action: 'project',
              result: `created ${p.name}${p.template ? ` from ${p.template}` : ''} →`,
              ...this.telemetry(path, 'cli')
            })
          } else {
            // rm: destructive — park at the existing confirmation gate
            const id = path.split('/').pop()!.replace(/\.md$/, '')
            this.setStatus(path, {
              status: 'needs_confirmation',
              via: 'cli',
              action: 'project_rm',
              title: p.name,
              ...this.telemetry(path, 'cli')
            })
            const timer = setTimeout(() => this.reject(id), config.confirmation_timeout_s * 1000)
            this.pendingConfirm.set(id, {
              action: 'project_rm',
              card: undefined,
              status: p.name,
              timer
            })
          }
        } catch (err) {
          this.setStatus(path, {
            status: 'attention',
            error: err instanceof Error ? err.message : String(err),
            ...this.telemetry(path, 'cli')
          })
        }
        return
      }

      if (parsed.kind === 'claimed') {
        // CLI claimed this instruction: patch frontmatter with via:cli and all parsed fields,
        // then execute without touching the resolver.
        const { cmd } = parsed
        // Open target under a 'create' policy: the work creates its own workspace.
        // Route through the existing create-then-delegate motion (crash-replay safe:
        // frontmatter advances create → delegate after the card exists).
        const action =
          !cmd.card &&
          (registry[cmd.action]?.target ?? 'required') === 'create' &&
          cmd.action !== 'create'
            ? 'create'
            : cmd.action
        this.setStatus(path, {
          via: 'cli',
          action,
          card: cmd.card,
          to: cmd.to,
          title: cmd.title,
          desc: cmd.desc,
          tags: cmd.tags.length ? cmd.tags : undefined,
          due: cmd.due,
          with: cmd.with,
          scope: cmd.scope
        })
        cliOpts = {
          title: cmd.title,
          desc: cmd.desc,
          tags: cmd.tags,
          due: cmd.due,
          with: cmd.with,
          scope: cmd.scope
        }
        if (cmd.card2) cliOpts = { ...cliOpts, card2: cmd.card2 }
        resolution = { kind: 'action' as const, action, card: cmd.card, status: cmd.to }
      } else if (parsed.kind === 'needs-card') {
        // Layered resolution: the CLI claimed the verb and every arg; only the
        // card reference stayed fuzzy. Ask the resolver that one narrow question
        // — which card? — instead of dropping the whole instruction back to
        // language. The action can no longer be misread; a miss parks with a
        // suggestion, never a wrong verb.
        const { cmd } = parsed
        hybrid = true
        this.setStatus(path, { via: 'cli+ai' })
        let picked
        try {
          picked = await resolveCardRef(parsed.query, cards, caps.resolver, config.thresholds.card)
        } catch (err) {
          this.setStatus(path, {
            status: 'attention',
            error: err instanceof Error ? err.message : String(err),
            ...this.telemetry(path, 'cli+ai')
          })
          return
        }
        if ('error' in picked) {
          this.setStatus(path, {
            status: 'attention',
            error: picked.error,
            ...this.telemetry(path, 'cli+ai')
          })
          return
        }
        this.setStatus(path, {
          action: cmd.action,
          card: picked.card,
          pick: picked.confidence,
          to: cmd.to,
          tags: cmd.tags.length ? cmd.tags : undefined,
          due: cmd.due,
          with: cmd.with,
          scope: cmd.scope
        })
        cliOpts = {
          title: cmd.title,
          desc: cmd.desc,
          tags: cmd.tags,
          due: cmd.due,
          with: cmd.with,
          scope: cmd.scope
        }
        resolution = {
          kind: 'action' as const,
          action: cmd.action,
          card: picked.card,
          status: cmd.to
        }
      } else {
        // Declined: first token is not a command, not a leading @collaborator,
        // not slash-forced, and not a '+' capture. It does NOT silently become a
        // card — a typo'd command or a stray line should never be filed. Park
        // loud so the mistake is visible and editable. Explicit capture is '+'.
        const firstTok = raw.trim().split(/\s+/)[0] ?? ''
        this.setStatus(path, {
          status: 'attention',
          error: `unknown command "${firstTok}" — start the line with + to capture a card`,
          ...this.telemetry(path, 'cli')
        })
        return
      }
    }

    const via: 'cli' | 'cli+ai' = hybrid ? 'cli+ai' : 'cli'

    const { action, card, status } = resolution
    if (card && this.frozen.has(card)) {
      this.setStatus(path, { status: 'queued' }) // wait for the attention to clear
      return
    }

    // No silent degradation, but no brick either: an action the parser claimed
    // that this (possibly hand-edited or stale) registry doesn't define parks
    // loud instead of crashing at registry[action].class on every boot.
    if (!registry[action]) {
      this.setStatus(path, {
        status: 'attention',
        action,
        card,
        error: `no registry entry for action "${action}" — add it to registry.json`,
        ...this.telemetry(path, via)
      })
      return
    }

    if (registry[action].class === 'destructive') {
      const id = path.split('/').pop()!.replace(/\.md$/, '')
      this.setStatus(path, {
        status: 'needs_confirmation',
        action,
        card,
        ...this.telemetry(path, via)
      })
      const timer = setTimeout(() => this.reject(id), config.confirmation_timeout_s * 1000)
      this.pendingConfirm.set(id, { action, card, status, timer })
      return
    }

    await this.execute(path, raw, pre, action, card, status, cliOpts, via)
  }

  private execute(
    path: string,
    raw: string,
    pre: ReturnType<typeof prepass>,
    action: string,
    card?: string,
    status?: string,
    opts?: ExecuteOpts,
    via: 'cli' | 'cli+ai' = 'cli'
  ): Promise<void> {
    const key = card ?? '__new__'
    const run = async (): Promise<void> => {
      // TOCTOU guard: re-check freeze state before executing — a prior instruction in this
      // chain may have just failed and frozen the card between when we enqueued and now
      if (card && this.frozen.has(card)) {
        this.setStatus(path, { status: 'queued' })
        return
      }
      const ctx = {
        tasksDir: this.deps.tasksDir,
        now: this.now()
      }
      try {
        let resolvedCard = card
        let finalAction = action
        if (action === 'create') {
          // opts carries CLI-parsed or pre-resolved fields; undefined means no opts.
          const createOpts =
            opts?.title || opts?.desc || opts?.tags || opts?.due || status
              ? {
                  title: opts?.title,
                  desc: opts?.desc,
                  tags: opts?.tags,
                  due: opts?.due,
                  status: status as CardStatus | undefined
                }
              : undefined
          resolvedCard = await handleCreate(ctx, pre, createOpts)
          // If a collaborator was named via `with`, advance frontmatter to action:delegate
          // before awaiting the delegation — crash/requeue now replays as delegation, not create.
          if (resolvedCard && opts?.with) {
            finalAction = 'delegate'
            this.setStatus(path, { action: 'delegate', card: resolvedCard })
            await this.delegateToCollaborator(resolvedCard, opts.with, opts?.title, opts?.scope)
          }
        } else if (action === 'update_status')
          handleUpdateStatus(ctx, card!, status as CardStatus, raw)
        else if (action === 'note') handleNote(ctx, card!, opts?.title ?? raw)
        else if (action === 'link') handleLink(ctx, card ?? pre.refs[0], opts?.card2 ?? pre.refs[1])
        else if (action === 'delete') handleDelete(ctx, card!)
        else if (action === 'label') handleLabel(ctx, card!, opts?.tags ?? [])
        else if (action === 'unlabel') handleUnlabel(ctx, card!, opts?.tags ?? [])
        else if (action === 'delegate') {
          if (!opts?.with) throw new Error('delegate needs a collaborator')
          await this.delegateToCollaborator(card!, opts.with, opts?.title, opts?.scope)
        } else if (action === 'rename') resolvedCard = handleRename(ctx, card!, opts?.title ?? raw)
        else if (action === 'reslug') resolvedCard = handleReslug(ctx, card!, opts?.title ?? '')
        else if (action === 'describe') handleDescribe(ctx, card!, opts?.desc ?? '')
        else if (action === 'open') {
          // UI nav, not a file op: publish a transient open request the board
          // picks up over the snapshot. The card was resolved like any card verb.
          if (!existsSync(join(this.deps.tasksDir, 'cards', `${card}.md`)))
            throw new Error(`card not found: ${card}`)
          this.navState = { card: card!, seq: ++this.navSeq }
        } else throw new Error(`no handler for action "${action}"`)
        this.refreshCardFacts() // engine write — absorb before the watcher diffs it
        this.setStatus(path, {
          status: 'done',
          via,
          action: finalAction,
          card: resolvedCard,
          ...this.telemetry(path, via)
        })
      } catch (err) {
        this.refreshCardFacts()
        this.setStatus(path, {
          status: 'attention',
          via,
          action,
          card,
          error: err instanceof Error ? err.message : String(err),
          ...this.telemetry(path, via)
        })
        if (card) this.frozen.add(card)
      }
    }
    const chained = (this.chains.get(key) ?? Promise.resolve()).then(run)
    this.chains.set(key, chained)
    this.track(chained)
    return chained
  }

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
    writeFileAtomic(join(dir, file), output)
    appendLog(
      join(this.deps.tasksDir, 'cards', `${card}.md`),
      `${now.toISOString().slice(0, 16).replace('T', ' ')} — delegated (${label}) → artifacts/${card}/${file}`
    )
    this.refreshCardFacts()
  }

  /** Author an output by hand: create a new empty artifact and log it, exactly
   *  like a delegation minus the model. The card-file log line trips the watcher
   *  so the new artifact row appears on the board. Returns the filename. */
  createArtifact(card: string): string {
    const cardPath = join(this.deps.tasksDir, 'cards', `${card}.md`)
    if (!existsSync(cardPath)) throw new Error(`no card "#${card}"`)
    const now = this.now()
    const dir = join(this.deps.tasksDir, 'artifacts', card)
    mkdirSync(dir, { recursive: true })
    const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
    let file = `${stamp}.md`
    let n = 1
    while (existsSync(join(dir, file))) file = `${stamp}-${n++}.md`
    writeFileAtomic(join(dir, file), '')
    appendLog(
      cardPath,
      `${now.toISOString().slice(0, 16).replace('T', ' ')} — output added by hand → artifacts/${card}/${file}`
    )
    this.refreshCardFacts()
    return file
  }

  /** Read the bodies of a card's prior artifacts (oldest → newest). */
  private readArtifactTexts(card: string): string[] {
    const dir = join(this.deps.tasksDir, 'artifacts', card)
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((n) => n.endsWith('.md'))
      .sort()
      .map((n) => readFileSync(join(dir, n), 'utf-8').trim())
      .filter(Boolean)
  }

  private async delegateToCollaborator(
    card: string,
    name: string,
    text?: string,
    scope?: Scope
  ): Promise<void> {
    const collaborator = this.deps.config.collaborators?.[name]
    const use = collaborator?.use
    if (!use) throw new Error(`unknown collaborator "${name}"`)
    const c = readCard(join(this.deps.tasksDir, 'cards', `${card}.md`))

    // Privacy choke point: a card marked private never reaches an external agent.
    // The local generator runs on-device, so it is still permitted.
    const privateLabel = this.deps.config.ui?.private_label ?? 'private'
    if (use === 'agent' && c.labels.includes(privateLabel))
      throw new Error(`card #${card} is #${privateLabel} — not sent to external agent @${name}`)

    // A collaborator may carry its own default scope; the instruction's scope wins.
    const effective: Scope = scope ?? collaborator.scope ?? 'card'
    const context = buildDelegationContext({
      card: c,
      scope: effective,
      text,
      artifactTexts: effective === 'card' ? [] : this.readArtifactTexts(card),
      board: effective === 'board' ? readSnapshot(this.deps.tasksDir).cards : [],
      privateLabel
    })
    const prompt =
      context +
      '\n\nReply with the deliverable text only (markdown welcome) — the caller stores your reply as a file; do not attempt to write files or call tools to save it.'
    const output = await this.runExecutor(use, prompt)
    this.writeArtifact(card, name, output)
  }

  async confirm(id: string): Promise<void> {
    const pending = this.pendingConfirm.get(id)
    if (!pending) throw new Error(`no pending confirmation for ${id}`)
    clearTimeout(pending.timer)
    this.pendingConfirm.delete(id)
    const path = this.qpath(id)
    if (pending.action === 'project_rm') {
      // I1: read durable name from frontmatter title as fallback (survives crash between park + confirm)
      const name = pending.status ?? readInstruction(path).title
      if (!name) {
        this.setStatus(path, { status: 'attention', error: 'project_rm: lost project name' })
        return
      }
      try {
        await this.deps.projects!.remove(name)
        // I2: when the removed project IS the active one, its dir (containing `path`) is trashed
        // before this point — guard against ENOENT
        if (existsSync(path))
          this.setStatus(path, {
            status: 'done',
            result: `removed ${name} (recoverable in workspace/.trash)`,
            ...this.telemetry(path, 'cli')
          })
      } catch (err) {
        if (existsSync(path))
          this.setStatus(path, {
            status: 'attention',
            error: err instanceof Error ? err.message : String(err),
            ...this.telemetry(path, 'cli')
          })
      }
      return
    }
    const inst = readInstruction(path)
    const pre = prepass(inst.raw, this.deps.caps.dates, this.now(), this.deps.registry)
    // Rebuild opts from the instruction's persisted frontmatter — patched at claim time —
    // so CLI-parsed fields (title, desc, tags, due, with) are not lost through confirmation.
    const opts: ExecuteOpts | undefined =
      (inst.title ?? inst.desc ?? inst.tags ?? inst.due ?? inst.with)
        ? {
            title: inst.title,
            desc: inst.desc,
            tags: inst.tags,
            due: inst.due,
            with: inst.with
          }
        : undefined
    // Time the confirmed execution itself; the instruction's engine marker is preserved.
    this.startedAt.set(path, this.now().getTime())
    await this.execute(
      path,
      inst.raw,
      pre,
      pending.action,
      pending.card,
      pending.status,
      opts,
      inst.via === 'cli+ai' ? 'cli+ai' : 'cli'
    )
  }

  reject(id: string): void {
    const pending = this.pendingConfirm.get(id)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingConfirm.delete(id)
    }
    if (existsSync(this.qpath(id)))
      this.setStatus(this.qpath(id), { status: 'done', error: 'rejected' })
  }

  requeue(id: string, text?: string): void {
    const path = this.qpath(id)
    // Clear any live pendingConfirm timer before requeuing — a stale timer would otherwise
    // reject the re-parked confirmation after the original timeout fires.
    const existing = this.pendingConfirm.get(id)
    if (existing) {
      clearTimeout(existing.timer)
      this.pendingConfirm.delete(id)
    }
    const inst = readInstruction(path)
    if (inst.card) this.frozen.delete(inst.card)
    for (const ref of inst.raw.matchAll(/#([a-z0-9-]+)/gi)) this.frozen.delete(ref[1].toLowerCase())
    if (text !== undefined) {
      rmSync(path)
      const newId = writeInstruction(this.deps.tasksDir, text, this.now())
      this.track(this.processFile(this.qpath(newId)))
    } else {
      // Requeue means start over: wipe any stale resolution from a failed attempt so the
      // instruction re-resolves instead of replaying the old action as pre-resolved.
      // Requeuing from this machine takes ownership — it runs here, whoever wrote it.
      this.setStatus(path, {
        status: 'queued',
        device: this.deps.device,
        error: undefined,
        action: undefined,
        card: undefined,
        to: undefined
      })
      this.track(this.processFile(path))
    }
    this.rescanQueued()
  }

  deleteInstruction(id: string): void {
    const path = this.qpath(id)
    // Clear any live pendingConfirm timer so the timeout never fires after deletion.
    const pending = this.pendingConfirm.get(id)
    if (pending) {
      clearTimeout(pending.timer)
      this.pendingConfirm.delete(id)
    }
    // Unfreeze the card and any #refs from the instruction body — same logic as requeue.
    try {
      const inst = readInstruction(path)
      if (inst.card) this.frozen.delete(inst.card)
      for (const m of inst.raw.matchAll(/#([a-z0-9-]+)/gi)) this.frozen.delete(m[1].toLowerCase())
    } catch {
      // File may already be gone; proceed to remove and rescan regardless.
    }
    if (existsSync(path)) rmSync(path)
    this.deps.onChange()
    this.rescanQueued()
  }

  private rescanQueued(): void {
    for (const f of readdirSync(this.queueDir()).filter((n) => n.endsWith('.md'))) {
      this.track(this.processFile(join(this.queueDir(), f)))
    }
  }
}
