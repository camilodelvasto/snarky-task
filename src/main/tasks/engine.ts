// src/main/tasks/engine.ts
import { watch, FSWatcher } from 'chokidar'
import { readdirSync, rmSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'fs'
import { join } from 'path'
import { readInstruction, patchInstruction, writeInstruction, appendLog, readCard } from './files'
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
  handleUnlabel
} from './handlers'
import { parseCommand } from './cli'
import type { Registry, TaskdeckConfig, CardStatus, RegistryAliases } from './types'
import type { Capabilities } from '../capabilities/contracts'
import { JobPool } from './jobs'

type ExecuteOpts = {
  title?: string
  desc?: string
  tags?: string[]
  due?: string
  with?: string
  card2?: string
}

export interface EngineDeps {
  tasksDir: string
  registry: Registry
  config: TaskdeckConfig
  caps: Capabilities
  aliases: RegistryAliases
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
  private pool: JobPool
  private cardFacts = new Map<string, CardFacts>()
  private startedAt = new Map<string, number>()

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
        this.cardFacts.set(p, { status: c.status, description: c.description, title: c.title })
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
    const next = { status: card.status, description: card.description, title: card.title }
    const changes = diffCard(this.cardFacts.get(path), next)
    this.cardFacts.set(path, next)
    const stamp = this.now().toISOString().slice(0, 16).replace('T', ' ')
    for (const change of changes) appendLog(path, `${stamp} — ${change}`)
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
      await this.pipeline(path, inst)
    } finally {
      this.inflight.delete(path)
    }
  }

  private setStatus(path: string, patch: Parameters<typeof patchInstruction>[1]): void {
    patchInstruction(path, patch)
    this.deps.onChange()
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
        with: inst.with
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
        )
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
          with: cmd.with
        })
        cliOpts = { title: cmd.title, desc: cmd.desc, tags: cmd.tags, due: cmd.due, with: cmd.with }
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
          with: cmd.with
        })
        cliOpts = { title: cmd.title, desc: cmd.desc, tags: cmd.tags, due: cmd.due, with: cmd.with }
        resolution = {
          kind: 'action' as const,
          action: cmd.action,
          card: picked.card,
          status: cmd.to
        }
      } else {
        // No verb, no leading @collaborator, no slash: language is captured.
        // Nobody — and no model — picks the action (spec: absence of command
        // means create). The create handler owns title cleanup, due extraction,
        // #ref links, #tag labels via prepass.
        resolution = { kind: 'action' as const, action: 'create' }
      }
    }

    const via: 'cli' | 'cli+ai' = hybrid ? 'cli+ai' : 'cli'

    const { action, card, status } = resolution
    if (card && this.frozen.has(card)) {
      this.setStatus(path, { status: 'queued' }) // wait for the attention to clear
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
        now: this.now(),
        generator: this.deps.caps.generator
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
            await this.delegateToCollaborator(resolvedCard, opts.with, opts?.title)
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
          await this.delegateToCollaborator(card!, opts.with, opts?.title)
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
    writeFileSync(join(dir, file), output)
    appendLog(
      join(this.deps.tasksDir, 'cards', `${card}.md`),
      `${now.toISOString().slice(0, 16).replace('T', ' ')} — delegated (${label}) → artifacts/${card}/${file}`
    )
    this.refreshCardFacts()
  }

  private async delegateToCollaborator(card: string, name: string, text?: string): Promise<void> {
    const use = this.deps.config.collaborators?.[name]?.use
    if (!use) throw new Error(`unknown collaborator "${name}"`)
    const c = readCard(join(this.deps.tasksDir, 'cards', `${card}.md`))
    const parts = [c.title, c.description, text ?? ''].filter((p) => p.trim())
    const prompt =
      parts.join('\n\n') +
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
      this.setStatus(path, {
        status: 'queued',
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
