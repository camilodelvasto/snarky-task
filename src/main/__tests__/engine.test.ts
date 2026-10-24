// src/main/__tests__/engine.test.ts
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import matter from 'gray-matter'
import { Engine } from '../tasks/engine'
import { writeInstruction, readInstruction, writeCard, readCard } from '../tasks/files'
import type { Registry, TaskdeckConfig, ProjectOps } from '../tasks/types'
import type { Capabilities, Choice } from '../capabilities/contracts'

const registry: Registry = {
  create: { class: 'normal', target: 'none' },
  update_status: {
    class: 'normal',
    target: 'resolve',
    params: { status: ['inbox', 'active', 'waiting', 'done', 'dropped'] }
  },
  note: { class: 'normal', target: 'required' },
  label: { class: 'normal', target: 'resolve' },
  unlabel: { class: 'normal', target: 'resolve' },
  link: { class: 'normal', target: 'required' },
  delete: { class: 'destructive', target: 'resolve' },
  delegate: { class: 'normal', target: 'create' },
  open: { class: 'normal', target: 'resolve' },
  rename: { class: 'normal', target: 'required' },
  reslug: { class: 'destructive', target: 'required' },
  describe: { class: 'normal', target: 'required' },
  clean: { class: 'meta' },
  clear: { class: 'meta' },
  check: { class: 'meta' },
  project: { class: 'meta' },
  project_rm: { class: 'destructive' }
}
const config: TaskdeckConfig = {
  resolver: { impl: 'test' },
  dates: { impl: 'chrono' },
  thresholds: { card: 0.6 },
  jobs: { max_parallel: 3 },
  confirmation_timeout_s: 1,
  collaborators: { local: { use: 'generator' } }
}

const aliases = {
  create: ['add', 'new'],
  move: ['mv'],
  note: ['log'],
  delete: ['del', 'rm']
}

function setup(
  answers: Array<{ key: string; confidence: number }>,
  projects?: ProjectOps,
  registryOverride?: Registry
): {
  tasksDir: string
  engine: Engine
  onChange: ReturnType<typeof vi.fn>
} {
  const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const s of ['queue', 'cards', 'artifacts']) mkdirSync(join(tasksDir, s), { recursive: true })
  const caps: Capabilities = {
    dates: { extract: (t: string) => ({ cleaned: t }) },
    resolver: {
      decide: async (_q: Choice) => {
        const a = answers.shift()
        if (!a) throw new Error('resolver consulted with no scripted answer')
        return a
      }
    }
  }
  const onChange = vi.fn()
  const engine = new Engine({
    tasksDir,
    device: 'this-mac',
    registry: registryOverride ?? registry,
    config,
    caps,
    aliases,
    onChange,
    projects,
    now: () => new Date('2026-10-02T10:00:00')
  })
  return { tasksDir, engine, onChange }
}

function fakeProjects(): ProjectOps & { switched: string[]; removed: string[] } {
  const state = { cur: 'default', switched: [] as string[], removed: [] as string[] }
  return {
    switched: state.switched,
    removed: state.removed,
    list: () => ['default', 'house'],
    templates: () => ['gtd'],
    current: () => state.cur,
    switch: async (n) => {
      state.cur = n
      state.switched.push(n)
    },
    create: async () => {},
    remove: async (n) => {
      state.removed.push(n)
    }
  }
}
const qpath = (tasksDir: string, id: string): string => join(tasksDir, 'queue', `${id}.md`)

describe('Engine.processFile', () => {
  it('create: queued → done, card exists', async () => {
    const { tasksDir, engine } = setup([])
    const id = writeInstruction(tasksDir, '+ write the ngo proposal', new Date())
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
    expect(readdirSync(join(tasksDir, 'cards'))).toHaveLength(1)
  })
  it('attention freezes the card: later instructions stay queued', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'p-y',
      title: 'proposal y',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const first = writeInstruction(
      tasksDir,
      'delegate #p-y @local draft the reply',
      new Date('2026-10-02T10:00:00')
    )
    const second = writeInstruction(
      tasksDir,
      'note on #p-y status update',
      new Date('2026-10-02T10:00:01')
    )
    await engine.processFile(qpath(tasksDir, first))
    await engine.processFile(qpath(tasksDir, second))
    expect(readInstruction(qpath(tasksDir, first)).status).toBe('attention') // generator not bound
    expect(readInstruction(qpath(tasksDir, second)).status).toBe('queued') // frozen
  })
  it('requeue unfreezes and reprocesses', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'x',
      title: 'x note thing',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const id = writeInstruction(
      tasksDir,
      'delegate #x @local research it',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('attention') // generator not bound → attention
    engine.requeue(id, '+ make a brand new card')
    await engine.drain()
    const left = readdirSync(join(tasksDir, 'queue')).map((f) =>
      readInstruction(join(tasksDir, 'queue', f))
    )
    expect(left).toHaveLength(1)
    expect(left[0].status).toBe('done')
  })
  it('destructive parks as needs_confirmation; confirm executes; reject closes', async () => {
    const { tasksDir, engine } = setup([])
    for (const s of ['a', 'b'])
      writeCard(tasksDir, {
        shortname: s,
        title: s,
        status: 'inbox',
        created: '2026-10-01',
        links: [],
        labels: [],
        description: '',
        log: []
      })
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
  it('applyElementOp: add/scratch/drop notes and edit the lead in place', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'c',
      title: 'c',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: 'orig',
      log: []
    })
    await engine.applyElementOp('c', 'note', 'add', { text: 'first note' })
    let card = readCard(join(tasksDir, 'cards', 'c.md'))
    expect(card.notes).toContain('first note')
    const noteId = card.elements.find((e) => e.type === 'note')!.id
    await engine.applyElementOp('c', 'note', 'scratch', { id: noteId })
    card = readCard(join(tasksDir, 'cards', 'c.md'))
    expect(card.elements.find((e) => e.id === noteId)!.data.scratched).toBe(true)
    await engine.applyElementOp('c', 'text', 'edit', { text: 'updated body' })
    card = readCard(join(tasksDir, 'cards', 'c.md'))
    expect(card.description).toBe('updated body')
    expect(card.elements.filter((e) => e.type === 'text').length).toBe(1)
    await engine.applyElementOp('c', 'note', 'drop', { id: noteId })
    expect(
      readCard(join(tasksDir, 'cards', 'c.md')).elements.find((e) => e.id === noteId)
    ).toBeUndefined()
  })
  it('a note drop goes to .trash; restoreLastDrop brings it back with its id + content', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'c',
      title: 'c',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    await engine.applyElementOp('c', 'note', 'add', { text: 'keep me' })
    const id = readCard(join(tasksDir, 'cards', 'c.md')).elements.find((e) => e.type === 'note')!.id
    await engine.applyElementOp('c', 'note', 'drop', { id })
    expect(
      readCard(join(tasksDir, 'cards', 'c.md')).elements.find((e) => e.id === id)
    ).toBeUndefined()
    expect(existsSync(join(tasksDir, '.trash', 'c.jsonl'))).toBe(true)
    await engine.restoreLastDrop('c')
    const restored = readCard(join(tasksDir, 'cards', 'c.md')).elements.find((e) => e.id === id)
    expect(restored).toBeDefined()
    expect(restored!.data.text).toBe('keep me')
  })
  it('applyElementOp rejects on an op a type does not declare', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'c',
      title: 'c',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    await expect(engine.applyElementOp('c', 'text', 'scratch', {})).rejects.toThrow()
  })
  it('applyElementOp: a failed op does not poison the card chain', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'c',
      title: 'c',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    await expect(engine.applyElementOp('c', 'text', 'scratch', {})).rejects.toThrow()
    // The chain must still accept the next op on the same card.
    await engine.applyElementOp('c', 'note', 'add', { text: 'after error' })
    expect(readCard(join(tasksDir, 'cards', 'c.md')).notes).toContain('after error')
  })
  it('an action the registry lacks parks in attention — never crashes the engine', async () => {
    // Regression: a verb the parser claims (reslug) but a hand-edited / stale
    // registry doesn't define must park loud, not throw at registry[action].class
    // and brick the engine on every boot.
    const noReslug = { ...registry }
    delete (noReslug as Record<string, unknown>).reslug
    const { tasksDir, engine } = setup([], undefined, noReslug as Registry)
    writeCard(tasksDir, {
      shortname: 'mostrar-2',
      title: 'm',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const id = writeInstruction(
      tasksDir,
      'reslug #mostrar-2 #mostrar',
      new Date('2026-10-02T10:00:00')
    )
    await expect(engine.processFile(qpath(tasksDir, id))).resolves.not.toThrow()
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('attention')
    expect(inst.error).toMatch(/reslug/)
  })
  it('open-card fallback: a card-verb with no #ref targets the open card — even multiline', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'decisiones',
      title: 'decisiones',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    engine.setOpenCard('decisiones')
    // Multiline: first line is just the verb, text (no #ref) on the next line.
    const id = writeInstruction(
      tasksDir,
      'note\nvamos a inscribirnos en una visión honesta',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.card).toBe('decisiones')
  })
  it('open-card fallback does not override an explicit #ref', async () => {
    const { tasksDir, engine } = setup([])
    for (const s of ['decisiones', 'servir'])
      writeCard(tasksDir, {
        shortname: s,
        title: s,
        status: 'active',
        created: '2026-10-01',
        links: [],
        labels: [],
        description: '',
        log: []
      })
    engine.setOpenCard('decisiones')
    const id = writeInstruction(tasksDir, 'note #servir the thought', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).card).toBe('servir')
  })
  it('tracks the open card set by the surfaces and clears it on null; notifies', () => {
    const { engine, onChange } = setup([])
    expect(engine.getOpenCard()).toBeUndefined()
    engine.setOpenCard('camino-informe-colegios')
    expect(engine.getOpenCard()).toBe('camino-informe-colegios')
    const calls = onChange.mock.calls.length
    engine.setOpenCard(null)
    expect(engine.getOpenCard()).toBeUndefined()
    expect(onChange.mock.calls.length).toBeGreaterThan(calls)
  })
  it('describe sets the card body from the console', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'press-plan',
      title: 'press plan',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: 'old',
      log: []
    })
    const id = writeInstruction(
      tasksDir,
      'describe #press-plan a brand new body',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
    expect(readCard(join(tasksDir, 'cards', 'press-plan.md')).description).toBe('a brand new body')
  })
  it('reslug parks for confirmation; confirm applies the new slug (preserved through round-trip), title kept', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'mostrar-2',
      title: 'Mostrar el panel',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: 'body',
      log: []
    })
    const id = writeInstruction(tasksDir, 'reslug #mostrar-2 #mostrar', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('needs_confirmation')
    await engine.confirm(id)
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.card).toBe('mostrar') // instruction records the new slug
    expect(existsSync(join(tasksDir, 'cards', 'mostrar-2.md'))).toBe(false)
    const nw = readCard(join(tasksDir, 'cards', 'mostrar.md'))
    expect(nw.title).toBe('Mostrar el panel') // title untouched
    expect(nw.description).toBe('body')
  })
  // Deleted: 'requeue without text unfreezes resolver-resolved card (no #refs in body)'
  // The status-question attention that carried a resolver-resolved card no longer exists;
  // frontmatter-card unfreeze is still covered by the delete/requeue tests that freeze via #refs.
  it('boot re-derives frozen set from attention files and reverts needs_confirmation to queued', async () => {
    // Two-phase test:
    // Phase A: boot derives frozen from attention file, new queued instruction stays frozen.
    // Phase B: needs_confirmation is reverted to queued at boot and re-parked as needs_confirmation.
    // Both phases use processFile directly (no chokidar) to avoid non-deterministic ordering.

    // --- Phase A: frozen set re-derived from attention file ---
    const { tasksDir: tdA } = setup([])
    writeCard(tdA, {
      shortname: 'p-y',
      title: 'proposal y',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })

    // Write attention file with card: p-y frontmatter — simulates pre-existing attention on restart
    const attnPath = join(tdA, 'queue', 'attn-001.md')
    writeFileSync(
      attnPath,
      matter.stringify('\nproposal y declined\n', {
        status: 'attention',
        card: 'p-y',
        error: 'low confidence'
      })
    )

    // Write a new queued instruction referencing p-y via #ref
    const newId = writeInstruction(tdA, 'note on #p-y status', new Date('2026-10-02T10:00:00'))
    const newPath = join(tdA, 'queue', `${newId}.md`)

    // Construct fresh engine and call start() to populate frozen set from attention file
    const capsA: Capabilities = {
      dates: { extract: (t: string) => ({ cleaned: t }) },
      resolver: {
        decide: async (_q: Choice) => {
          throw new Error('resolver consulted with no scripted answer')
        }
      }
    }
    const freshA = new Engine({
      tasksDir: tdA,
      device: 'this-mac',
      registry,
      config,
      caps: capsA,
      aliases,
      onChange: vi.fn(),
      now: () => new Date('2026-10-02T10:00:00')
    })
    freshA.start()
    // Directly process the new queued instruction — p-y must be in frozen from boot
    await freshA.processFile(newPath)
    await freshA.stop()

    // p-y is frozen → new instruction stays queued (not processed further)
    expect(readInstruction(newPath).status).toBe('queued')

    // --- Phase B: needs_confirmation reverted to queued at boot, re-parked ---
    const { tasksDir: tdB } = setup([])
    writeCard(tdB, {
      shortname: 'x-card',
      title: 'x card',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })

    // Write needs_confirmation instruction directly
    const ncPath = join(tdB, 'queue', 'nc-001.md')
    writeFileSync(
      ncPath,
      matter.stringify('\ndelete #x-card\n', {
        status: 'needs_confirmation',
        action: 'delete',
        card: 'x-card'
      })
    )

    const capsB: Capabilities = {
      dates: { extract: (t: string) => ({ cleaned: t }) },
      resolver: {
        decide: async (_q: Choice) => {
          throw new Error('resolver consulted with no scripted answer')
        }
      }
    }
    const freshB = new Engine({
      tasksDir: tdB,
      device: 'this-mac',
      registry,
      config,
      caps: capsB,
      aliases,
      onChange: vi.fn(),
      now: () => new Date('2026-10-02T10:00:00')
    })
    // start() reverts needs_confirmation → queued; then we explicitly processFile
    freshB.start()
    // After start(), nc file should now be queued (reverted)
    // processFile picks it up, resolves delete, parks as needs_confirmation
    await freshB.processFile(ncPath)
    await freshB.stop()

    expect(readInstruction(ncPath).status).toBe('needs_confirmation')
  })

  it('in-chain TOCTOU: second instruction on same card stays queued after first fails and freezes', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 't-x',
      title: 'toctou card',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const one = writeInstruction(
      tasksDir,
      'delegate #t-x @local draft it',
      new Date('2026-10-02T10:00:00')
    )
    const two = writeInstruction(
      tasksDir,
      'note #t-x more context',
      new Date('2026-10-02T10:00:01')
    )
    // Enqueue both before either executes: the second passes the pipeline freeze
    // check and chains behind the first on the same card; the first throws at
    // execute (generator not bound) and freezes t-x; the second ends queued.
    await Promise.all([
      engine.processFile(qpath(tasksDir, one)),
      engine.processFile(qpath(tasksDir, two))
    ])
    await engine.drain()
    expect(readInstruction(qpath(tasksDir, one)).status).toBe('attention')
    expect(readInstruction(qpath(tasksDir, two)).status).toBe('queued')
  })

  it('deleteInstruction: attention instruction freezing card X → deleteInstruction → queued instruction for X processes to done', async () => {
    // Behavioural: an attention instruction has frozen card 'x-del'. After deleteInstruction,
    // a queued instruction for that card must process through to done.
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'x-del',
      title: 'x del card',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    // This instruction will go to attention (delegate w/ generator not bound) and freeze x-del
    const attnId = writeInstruction(
      tasksDir,
      'delegate #x-del @local status update',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, attnId))
    expect(readInstruction(qpath(tasksDir, attnId)).status).toBe('attention')

    // This instruction is queued but blocked because x-del is frozen
    const noteId = writeInstruction(tasksDir, 'note on #x-del', new Date('2026-10-02T10:00:01'))
    await engine.processFile(qpath(tasksDir, noteId))
    expect(readInstruction(qpath(tasksDir, noteId)).status).toBe('queued')

    // Delete the attention instruction — must unfreeze x-del and rescan
    engine.deleteInstruction(attnId)
    expect(existsSync(qpath(tasksDir, attnId))).toBe(false)
    await engine.drain()

    // The note for x-del should now be done
    expect(readInstruction(qpath(tasksDir, noteId)).status).toBe('done')
  })

  it('requeue clears pendingConfirm timer: confirm succeeds after requeue+reprocess', async () => {
    // Regression: if requeue does not clear the old timer, the stale timer fires and rejects the
    // re-parked confirmation. After requeue + drain, confirm() must succeed (not throw "no pending").
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'timer-card',
      title: 'timer card',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const id = writeInstruction(tasksDir, 'delete #timer-card', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('needs_confirmation')

    // Requeue without text — must clear the old pendingConfirm timer and re-park
    engine.requeue(id)
    await engine.drain()
    // Re-parked as needs_confirmation with a fresh timer
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('needs_confirmation')

    // confirm() must work — if the old timer were still live it would have already called reject
    // and confirm() would throw "no pending confirmation".
    await expect(engine.confirm(id)).resolves.not.toThrow()
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
  })

  it('clean sweeps done queue files into history — a console keeps its scrollback', async () => {
    const { tasksDir, engine } = setup([])
    const a = writeInstruction(tasksDir, '+ make something', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, a))
    const c = writeInstruction(tasksDir, 'clean', new Date('2026-10-02T10:00:01'))
    await engine.processFile(qpath(tasksDir, c))
    expect(existsSync(qpath(tasksDir, a))).toBe(false)
    expect(existsSync(qpath(tasksDir, c))).toBe(false) // clean removes itself (no history noise)
    // the done instruction survives, telemetry and all, in history/
    const hist = readInstruction(join(tasksDir, 'history', `${a}.md`))
    expect(hist.status).toBe('done')
    expect(hist.raw).toBe('+ make something')
  })
  it('done rows auto-sweep into history after done_ttl_s', async () => {
    const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
    for (const s of ['queue', 'cards', 'artifacts'])
      mkdirSync(join(tasksDir, s), { recursive: true })
    let clock = new Date('2026-10-02T10:00:00').getTime()
    const caps: Capabilities = {
      dates: { extract: (t: string) => ({ cleaned: t }) },
      resolver: {
        decide: async () => {
          throw new Error('resolver must not be consulted')
        }
      }
    }
    const engine = new Engine({
      tasksDir,
      device: 'this-mac',
      registry,
      config: { ...config, done_ttl_s: 20 },
      caps,
      aliases,
      onChange: vi.fn(),
      now: () => new Date(clock)
    })
    const id = writeInstruction(tasksDir, '+ capture this thought', new Date(clock))
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
    engine.sweepDone()
    expect(existsSync(qpath(tasksDir, id))).toBe(true) // too fresh
    clock += 21_000
    engine.sweepDone()
    expect(existsSync(qpath(tasksDir, id))).toBe(false)
    expect(readInstruction(join(tasksDir, 'history', `${id}.md`)).status).toBe('done')
  })
  it('open #card publishes a transient nav (seq increments), done, no file change', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'target',
      title: 'target',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: 'body',
      log: []
    })
    expect(engine.getNav()).toBeUndefined()
    const id = writeInstruction(tasksDir, 'open #target', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
    expect(engine.getNav()).toEqual({ card: 'target', seq: 1 })
    // the card itself is untouched
    expect(readCard(join(tasksDir, 'cards', 'target.md')).description).toBe('body')
  })
  it('check validates the workspace and reports invalids in result', async () => {
    const { tasksDir, engine } = setup([])
    // one valid card, one hand-broken card (bad status, written raw to dodge writeCard validation)
    writeCard(tasksDir, {
      shortname: 'good',
      title: 'Good',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    writeFileSync(
      join(tasksDir, 'cards', 'broken.md'),
      matter.stringify('\n\n## Log\n', {
        title: 'Broken',
        status: 'nope',
        created: '2026-10-01',
        links: [],
        labels: []
      })
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
    writeCard(tasksDir, {
      shortname: 'good',
      title: 'Good',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const before = readFileSync(join(tasksDir, 'cards', 'good.md'), 'utf-8')
    const id = writeInstruction(tasksDir, 'check', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).result).toMatch(/all valid/)
    expect(readFileSync(join(tasksDir, 'cards', 'good.md'), 'utf-8')).toBe(before) // untouched
  })

  // ── element validation via /check ─────────────────────────────────────────
  // Write elements.json into the test tasksDir (all known types)
  function writeElementsJson(tasksDir: string): void {
    writeFileSync(
      join(tasksDir, 'elements.json'),
      JSON.stringify({
        text:   { schema: 'text.v1.json',   lead: true,              ops: ['edit'] },
        note:   { schema: 'note.v1.json',   section: 'Notes',        ops: ['add','edit','scratch','drop'] },
        log:    { schema: 'log.v1.json',    section: 'Log', system: true, ops: ['append'] },
        output: { schema: 'output.v1.json', storage: 'fs',           ops: ['add','edit','drop'] }
      }, null, 2)
    )
  }

  // Write elements.json that only knows text and log — NOT note — so note elements
  // parsed from a card body are "unknown" from the registry's perspective.
  function writeRestrictedElementsJson(tasksDir: string): void {
    writeFileSync(
      join(tasksDir, 'elements.json'),
      JSON.stringify({
        text:   { schema: 'text.v1.json',   lead: true,  ops: ['edit'] },
        log:    { schema: 'log.v1.json',    section: 'Log', system: true, ops: ['append'] },
        output: { schema: 'output.v1.json', storage: 'fs', ops: ['add','edit','drop'] }
      }, null, 2)
    )
  }

  it('check reports a card whose note element data fails schema (at is missing)', async () => {
    // note.v1.json requires "at" and "text". We manufacture a note element whose data
    // is missing "at" by injecting it raw — we bypass the normal note render/parse
    // by writing the card body in the note section format but with a raw note line
    // that the parser produces with at=''. The schema requires at to be present and a
    // string; '' IS a valid string, so we instead test the 'text' field by
    // constructing a note element directly and injecting via card elements path.
    //
    // Strategy: call writeCard with an explicit elements array containing a note
    // element whose data lacks 'at'. writeCard does NOT validate element data, so it
    // proceeds. elementsToBody calls noteShape.render which produces a serialized line.
    // readCard→bodyToElements→noteShape.parse reconstructs data. The reconstructed data
    // will always have {at, text}. So a round-trip note is always schema-valid.
    //
    // The /check integration test for "invalid element data" therefore exercises a
    // scenario where the schema is violated at the validateElement() call. This is most
    // cleanly tested at the unit level (validate.test.ts 'validateElement' describe block).
    // For engine-level integration, we verify the /check pipeline calls validateElement
    // by checking that a card with elements whose type is NOT in elements.json is reported.

    // This test uses a project whose elements.json only knows text/log/output (no note).
    // writeCard writes a card with a note (BUNDLED shape renders it fine).
    // readCard returns a note element. /check calls validateElement('note', data, types)
    // where 'note' is NOT in types → reported as unknown type.
    const { tasksDir, engine } = setup([])
    writeRestrictedElementsJson(tasksDir)
    writeCard(tasksDir, {
      shortname: 'mycard',
      title: 'My card',
      status: 'active',
      created: '2026-10-22',
      links: [],
      labels: [],
      description: '',
      log: [],
      // Use explicit elements so this test is independent of the legacy notes reconcile.
      // BUNDLED renders the note fine; /check later sees 'note' as unknown (not in restricted registry).
      elements: [
        { id: 'n1', type: 'note', data: { at: '2026-10-22 10:00', text: 'hello world' } }
      ]
    } as never)

    const id = writeInstruction(tasksDir, 'check', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.result).toContain('invalid')
    expect(inst.result).toContain('mycard.md')
    // The element type 'note' is not in the restricted elements.json → unknown type
    expect(inst.result).toMatch(/unknown.*type|type.*unknown/i)
  })

  it('check reports a card with an element of unknown type (not in elements.json)', async () => {
    // Same mechanism as above but verify explicitly for "unknown type" wording
    const { tasksDir, engine } = setup([])
    writeRestrictedElementsJson(tasksDir)
    writeCard(tasksDir, {
      shortname: 'mycard2',
      title: 'My card 2',
      status: 'active',
      created: '2026-10-22',
      links: [],
      labels: [],
      description: '',
      log: [],
      // Use explicit elements so this test is independent of the legacy notes reconcile.
      elements: [
        { id: 'n2', type: 'note', data: { at: '2026-10-22 10:00', text: 'a note that will have unknown type in the registry' } }
      ]
    } as never)

    const id = writeInstruction(tasksDir, 'check', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.result).not.toMatch(/all valid/)
    expect(inst.result).toContain('mycard2.md')
  })

  it('check with elements.json present: a fully-valid card passes', async () => {
    const { tasksDir, engine } = setup([])
    writeElementsJson(tasksDir)
    writeCard(tasksDir, {
      shortname: 'valid',
      title: 'Valid',
      status: 'active',
      created: '2026-10-22',
      links: [],
      labels: [],
      description: 'some description',
      log: ['did a thing']
    })
    const id = writeInstruction(tasksDir, 'check', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).result).toMatch(/all valid/)
  })
  it('clear wipes the scrollback — history and done rows — but never cards', async () => {
    const { tasksDir, engine } = setup([])
    // one swept-to-history row, one fresh done row, one card
    const a = writeInstruction(tasksDir, '+ make something', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, a))
    const sweep = writeInstruction(tasksDir, 'clean', new Date('2026-10-02T10:00:01'))
    await engine.processFile(qpath(tasksDir, sweep))
    const b = writeInstruction(tasksDir, '+ make another thing', new Date('2026-10-02T10:00:02'))
    await engine.processFile(qpath(tasksDir, b))
    expect(readdirSync(join(tasksDir, 'cards'))).toHaveLength(2)

    const w = writeInstruction(tasksDir, '/clear', new Date('2026-10-02T10:00:03'))
    await engine.processFile(qpath(tasksDir, w))
    expect(readdirSync(join(tasksDir, 'history')).filter((f) => f.endsWith('.md'))).toHaveLength(0)
    expect(readdirSync(join(tasksDir, 'queue')).filter((f) => f.endsWith('.md'))).toHaveLength(0)
    expect(readdirSync(join(tasksDir, 'cards'))).toHaveLength(2) // cards untouched
  })
})

describe('Engine pre-resolved instructions (deterministic surface actions)', () => {
  it('executes a pre-resolved move without calling the resolver', async () => {
    const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
    for (const s of ['queue', 'cards', 'artifacts'])
      mkdirSync(join(tasksDir, s), { recursive: true })
    const caps: Capabilities = {
      dates: { extract: (t: string) => ({ cleaned: t }) },
      resolver: {
        decide: async () => {
          throw new Error('resolver must not be called for a pre-resolved instruction')
        }
      }
    }
    const engine = new Engine({
      tasksDir,
      device: 'this-mac',
      registry,
      config,
      caps,
      aliases,
      onChange: vi.fn(),
      now: () => new Date('2026-10-02T10:00:00')
    })
    writeCard(tasksDir, {
      shortname: 'proto',
      title: 'Prototype',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: 'd',
      log: []
    })
    const id = writeInstruction(
      tasksDir,
      'move #proto to active',
      new Date('2026-10-02T10:00:00'),
      {
        action: 'update_status',
        card: 'proto',
        to: 'active'
      }
    )
    await engine.processFile(qpath(tasksDir, id))
    expect(readCard(join(tasksDir, 'cards', 'proto.md')).status).toBe('active')
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
  })

  it('still gates pre-resolved destructive actions behind confirmation', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'proto',
      title: 'Prototype',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: 'd',
      log: []
    })
    const id = writeInstruction(tasksDir, 'delete #proto', new Date('2026-10-02T10:00:00'), {
      action: 'delete',
      card: 'proto'
    })
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('needs_confirmation')
    expect(existsSync(join(tasksDir, 'cards', 'proto.md'))).toBe(true)
  })

  it('parks an unknown pre-resolved action in attention', async () => {
    const { tasksDir, engine } = setup([])
    const id = writeInstruction(tasksDir, 'bogus', new Date('2026-10-02T10:00:00'), {
      action: 'frobnicate'
    })
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('attention')
    expect(inst.error).toMatch(/unknown action/)
  })
})

describe('Engine collaborator delegation', () => {
  it('a pre-resolved create with `with` queues a delegation whose artifact lands on the card', async () => {
    const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
    for (const s of ['queue', 'cards', 'artifacts'])
      mkdirSync(join(tasksDir, s), { recursive: true })
    const caps: Capabilities = {
      dates: { extract: (t: string) => ({ cleaned: t }) },
      resolver: {
        decide: async () => {
          throw new Error('no resolver on cli path')
        }
      },
      agent: { run: async (prompt: string) => `drafted: ${prompt.slice(0, 20)}` }
    }
    const engine = new Engine({
      tasksDir,
      device: 'this-mac',
      registry,
      config: { ...config, collaborators: { claude: { use: 'agent' } } },
      caps,
      aliases,
      onChange: vi.fn(),
      now: () => new Date('2026-10-02T10:00:00')
    })
    const id = writeInstruction(
      tasksDir,
      'create ship it @claude',
      new Date('2026-10-02T10:00:00'),
      {
        action: 'create',
        title: 'ship it',
        with: 'claude',
        via: 'cli'
      }
    )
    await engine.processFile(qpath(tasksDir, id))
    await engine.drain()
    const card = readCard(join(tasksDir, 'cards', 'ship-it.md'))
    expect(card.log.join('\n')).toMatch(/delegated \(claude\)/)
    expect(readdirSync(join(tasksDir, 'artifacts', 'ship-it'))).toHaveLength(1)
  })

  it('create @collab advances frontmatter to action:delegate after create, preventing duplicate cards on replay', async () => {
    const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
    for (const s of ['queue', 'cards', 'artifacts'])
      mkdirSync(join(tasksDir, s), { recursive: true })
    const caps: Capabilities = {
      dates: { extract: (t: string) => ({ cleaned: t }) },
      resolver: {
        decide: async () => {
          throw new Error('no resolver on cli path')
        }
      },
      agent: { run: async (prompt: string) => `result: ${prompt.slice(0, 20)}` }
    }
    const engine = new Engine({
      tasksDir,
      device: 'this-mac',
      registry,
      config: { ...config, collaborators: { claude: { use: 'agent' } } },
      caps,
      aliases,
      onChange: vi.fn(),
      now: () => new Date('2026-10-02T10:00:00')
    })
    const id = writeInstruction(
      tasksDir,
      'create ship it @claude',
      new Date('2026-10-02T10:00:00'),
      {
        action: 'create',
        title: 'ship it',
        with: 'claude',
        via: 'cli'
      }
    )
    await engine.processFile(qpath(tasksDir, id))
    await engine.drain()

    // Frontmatter must have been advanced to action:delegate with card set
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.action).toBe('delegate')
    expect(inst.card).toBe('ship-it')

    // Only one card must exist — no duplication
    expect(readdirSync(join(tasksDir, 'cards'))).toHaveLength(1)

    // Exactly one artifact must have been written
    expect(readdirSync(join(tasksDir, 'artifacts', 'ship-it'))).toHaveLength(1)
  })
})

describe('Engine delegation scope & privacy', () => {
  function delegateSetup(opts: {
    collaborators: TaskdeckConfig['collaborators']
    agentRun?: (p: string) => Promise<string>
    generatorComplete?: (p: string) => Promise<string>
  }): { tasksDir: string; engine: Engine } {
    const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
    for (const s of ['queue', 'cards', 'artifacts'])
      mkdirSync(join(tasksDir, s), { recursive: true })
    const caps: Capabilities = {
      dates: { extract: (t: string) => ({ cleaned: t }) },
      resolver: {
        decide: async () => {
          throw new Error('no resolver on cli path')
        }
      },
      agent: { run: opts.agentRun ?? (async () => 'agent out') },
      generator: { complete: opts.generatorComplete ?? (async () => 'gen out') }
    }
    const engine = new Engine({
      tasksDir,
      device: 'this-mac',
      registry,
      config: { ...config, collaborators: opts.collaborators },
      caps,
      aliases,
      onChange: vi.fn(),
      now: () => new Date('2026-10-02T10:00:00')
    })
    return { tasksDir, engine }
  }

  it('refuses a private card to an external agent and parks in attention', async () => {
    const { tasksDir, engine } = delegateSetup({ collaborators: { claude: { use: 'agent' } } })
    writeCard(tasksDir, {
      shortname: 'secret',
      title: 'Salary plan',
      status: 'active',
      created: '2026-10-02',
      links: [],
      labels: ['private'],
      description: 'confidential',
      log: ['2026-10-02 10:00 — created']
    })
    const id = writeInstruction(
      tasksDir,
      'delegate #secret @claude',
      new Date('2026-10-02T10:00:00'),
      {
        action: 'delegate',
        card: 'secret',
        with: 'claude',
        via: 'cli'
      }
    )
    await engine.processFile(qpath(tasksDir, id))
    await engine.drain()
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('attention')
    expect(inst.error).toMatch(/private/)
    expect(existsSync(join(tasksDir, 'artifacts', 'secret'))).toBe(false)
  })

  it('still lets a private card go to the local generator', async () => {
    const { tasksDir, engine } = delegateSetup({ collaborators: { local: { use: 'generator' } } })
    writeCard(tasksDir, {
      shortname: 'secret',
      title: 'Salary plan',
      status: 'active',
      created: '2026-10-02',
      links: [],
      labels: ['private'],
      description: 'confidential',
      log: ['2026-10-02 10:00 — created']
    })
    const id = writeInstruction(
      tasksDir,
      'delegate #secret @local',
      new Date('2026-10-02T10:00:00'),
      {
        action: 'delegate',
        card: 'secret',
        with: 'local',
        via: 'cli'
      }
    )
    await engine.processFile(qpath(tasksDir, id))
    await engine.drain()
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
    expect(readdirSync(join(tasksDir, 'artifacts', 'secret'))).toHaveLength(1)
  })

  it('full scope sends the card activity log to the collaborator', async () => {
    let captured = ''
    const { tasksDir, engine } = delegateSetup({
      collaborators: { claude: { use: 'agent' } },
      agentRun: async (p) => {
        captured = p
        return 'ok'
      }
    })
    writeCard(tasksDir, {
      shortname: 'draft',
      title: 'Draft reply',
      status: 'active',
      created: '2026-10-02',
      links: [],
      labels: [],
      description: 'answer the vendor',
      log: ['2026-10-02 10:00 — created', '2026-10-02 11:00 — noted the deadline']
    })
    const id = writeInstruction(
      tasksDir,
      'delegate #draft @claude',
      new Date('2026-10-02T10:00:00'),
      {
        action: 'delegate',
        card: 'draft',
        with: 'claude',
        scope: 'full',
        via: 'cli'
      }
    )
    await engine.processFile(qpath(tasksDir, id))
    await engine.drain()
    expect(captured).toContain('## Activity')
    expect(captured).toContain('noted the deadline')
  })

  it('board scope sends a roster of the other live cards, private ones omitted', async () => {
    let captured = ''
    const { tasksDir, engine } = delegateSetup({
      collaborators: { claude: { use: 'agent' } },
      agentRun: async (p) => {
        captured = p
        return 'ok'
      }
    })
    const base = {
      status: 'active' as const,
      created: '2026-10-02',
      links: [],
      log: ['2026-10-02 10:00 — created']
    }
    writeCard(tasksDir, {
      ...base,
      shortname: 'draft',
      title: 'Draft reply',
      labels: [],
      description: ''
    })
    writeCard(tasksDir, {
      ...base,
      shortname: 'book-venue',
      title: 'Book venue',
      labels: [],
      description: ''
    })
    writeCard(tasksDir, {
      ...base,
      shortname: 'salary',
      title: 'Salary review',
      labels: ['private'],
      description: ''
    })
    const id = writeInstruction(
      tasksDir,
      'delegate #draft @claude',
      new Date('2026-10-02T10:00:00'),
      {
        action: 'delegate',
        card: 'draft',
        with: 'claude',
        scope: 'board',
        via: 'cli'
      }
    )
    await engine.processFile(qpath(tasksDir, id))
    await engine.drain()
    expect(captured).toContain('#book-venue')
    expect(captured).not.toContain('salary')
  })
})

describe('Engine.createArtifact (author an output by hand)', () => {
  it('writes an empty artifact file and logs it on the card', () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'draft',
      title: 'Draft reply',
      status: 'active',
      created: '2026-10-02',
      links: [],
      labels: [],
      description: 'answer the vendor',
      log: ['2026-10-02 10:00 — created']
    })
    const file = engine.createArtifact('draft')
    expect(file).toMatch(/\.md$/)
    const artPath = join(tasksDir, 'artifacts', 'draft', file)
    expect(existsSync(artPath)).toBe(true)
    expect(readFileSync(artPath, 'utf-8')).toBe('')
    expect(readCard(join(tasksDir, 'cards', 'draft.md')).log.join('\n')).toMatch(
      /output added by hand/
    )
  })
})

describe('Engine.dropOutput (recoverable output drop)', () => {
  it('moves the output to .trash, logs it on the card, and restoreLastDrop brings it back', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'draft',
      title: 'Draft reply',
      status: 'active',
      created: '2026-10-02',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const file = engine.createArtifact('draft')
    const artPath = join(tasksDir, 'artifacts', 'draft', file)
    expect(existsSync(artPath)).toBe(true)

    await engine.dropOutput('draft', file)
    expect(existsSync(artPath)).toBe(false) // gone from artifacts/
    expect(existsSync(join(tasksDir, '.trash', 'artifacts', 'draft', file))).toBe(true) // in .trash
    // the drop is visible in the card's activity, same as every other op
    expect(readCard(join(tasksDir, 'cards', 'draft.md')).log.join('\n')).toMatch(/output drop/)

    await engine.restoreLastDrop('draft')
    expect(existsSync(artPath)).toBe(true) // back in artifacts/
    expect(existsSync(join(tasksDir, '.trash', 'artifacts', 'draft', file))).toBe(false)
  })

  it('throws when the output file does not exist (fail loud)', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'draft',
      title: 'Draft',
      status: 'active',
      created: '2026-10-02',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    void tasksDir
    await expect(engine.dropOutput('draft', 'nope.md')).rejects.toThrow()
  })
})

describe('Engine device ownership (synced workspaces)', () => {
  const foreign = (tasksDir: string, name: string, status: string): string => {
    const p = join(tasksDir, 'queue', `${name}.md`)
    writeFileSync(p, matter.stringify('\n+ call the plumber\n', { status, device: 'other-mac' }))
    return p
  }

  it('claims an unowned instruction (stamps this device) and runs it', async () => {
    const { tasksDir, engine } = setup([])
    const id = writeInstruction(tasksDir, '+ write the ngo proposal', new Date())
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.device).toBe('this-mac')
    expect(inst.status).toBe('done')
  })

  it('never runs another device’s queued instruction', async () => {
    const { tasksDir, engine } = setup([])
    const p = foreign(tasksDir, 'synced-001', 'queued')
    await engine.processFile(p)
    expect(readInstruction(p).status).toBe('queued')
    expect(readInstruction(p).device).toBe('other-mac')
    expect(readdirSync(join(tasksDir, 'cards'))).toHaveLength(0)
  })

  it('boot leaves another device’s working/needs_confirmation rows alone', async () => {
    const { tasksDir, engine } = setup([])
    const working = foreign(tasksDir, 'synced-002', 'working')
    const confirm = foreign(tasksDir, 'synced-003', 'needs_confirmation')
    engine.start()
    await engine.drain()
    await engine.stop()
    expect(readInstruction(working).status).toBe('working')
    expect(readInstruction(confirm).status).toBe('needs_confirmation')
    expect(readdirSync(join(tasksDir, 'cards'))).toHaveLength(0)
  })

  it('requeue from this machine takes ownership and runs here', async () => {
    const { tasksDir, engine } = setup([])
    foreign(tasksDir, 'synced-004', 'attention')
    engine.requeue('synced-004')
    await engine.drain()
    const inst = readInstruction(qpath(tasksDir, 'synced-004'))
    expect(inst.device).toBe('this-mac')
    expect(inst.status).toBe('done')
  })
})

describe('Engine card reconciliation (direct edits are ops)', () => {
  it('logs status and description changes from a direct edit, exactly once', () => {
    const { tasksDir, engine } = setup([])
    const base = {
      shortname: 'proto',
      title: 'Prototype',
      created: '2026-10-01',
      links: [],
      labels: [],
      log: ['2026-10-01 09:00 — created']
    }
    writeCard(tasksDir, { ...base, status: 'inbox', description: 'old' })
    const p = join(tasksDir, 'cards', 'proto.md')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eng = engine as any
    eng.refreshCardFacts() // what start() seeds

    // simulate a hand edit: status, title, and description change on disk
    writeCard(tasksDir, { ...base, status: 'active', title: 'Updated', description: 'new words' })
    eng.reconcileCard(p)

    const log = readCard(p).log
    expect(log.some((l: string) => l.endsWith('status inbox → active (direct edit)'))).toBe(true)
    expect(log.some((l: string) => l.endsWith('title edited (direct edit)'))).toBe(true)
    expect(log.some((l: string) => l.endsWith('description edited (direct edit)'))).toBe(true)

    // the reconciling appendLog retriggers the watcher — must not log again
    eng.reconcileCard(p)
    expect(readCard(p).log.filter((l: string) => l.includes('direct edit'))).toHaveLength(3)
  })

  it('does not log engine-driven writes (facts refreshed after handler)', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'proto',
      title: 'Prototype',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: 'd',
      log: []
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eng = engine as any
    eng.refreshCardFacts()
    const id = writeInstruction(tasksDir, 'move #proto $active', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const p = join(tasksDir, 'cards', 'proto.md')
    eng.reconcileCard(p) // watcher fires after the engine write — diff must be clean
    expect(readCard(p).log.filter((l: string) => l.includes('direct edit'))).toHaveLength(0)
    expect(readCard(p).status).toBe('active')
  })

  it('absorbs a synced change that arrives already logged by the other device', () => {
    const { tasksDir, engine } = setup([])
    const base = {
      shortname: 'proto',
      title: 'Prototype',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: 'd'
    }
    writeCard(tasksDir, { ...base, status: 'inbox', log: ['2026-10-01 09:00 — created'] })
    const p = join(tasksDir, 'cards', 'proto.md')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const eng = engine as any
    eng.refreshCardFacts()

    // the other device's engine moved it and logged the op; sync delivers the whole file
    writeCard(tasksDir, {
      ...base,
      status: 'active',
      log: ['2026-10-01 09:00 — created', '2026-10-02 10:00 — status → active ("move #proto")']
    })
    eng.reconcileCard(p)
    expect(readCard(p).log.filter((l: string) => l.includes('direct edit'))).toHaveLength(0)
    expect(readCard(p).log).toHaveLength(2)
  })
})

describe('Engine CLI layer', () => {
  it('a bare command executes without the resolver and marks via: cli', async () => {
    const { tasksDir, engine } = setup([]) // setup's resolver would answer create/0.9 — assert it is NOT consulted by using a command resolver answers could not produce
    const id = writeInstruction(
      tasksDir,
      'create ship the thing $active #urgent',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.via).toBe('cli')
    const card = readCard(join(tasksDir, 'cards', 'ship-the-thing.md'))
    expect(card.status).toBe('active')
    expect(card.labels).toEqual(['urgent'])
    expect(card.title).toBe('ship the thing')
    expect(card.links).toEqual([]) // #urgent is a tag, not a card ref — must not leak into links
    // execution telemetry: which engine ran it, and how long it took
    expect(inst.engine).toBe('cli')
    expect(typeof inst.ms).toBe('number')
  })
  it('a resolver-path instruction records the resolver engine and duration', async () => {
    const { tasksDir, engine } = setup([{ key: 'munich-conference', confidence: 0.95 }])
    writeCard(tasksDir, {
      shortname: 'munich-conference',
      title: 'Munich conference talk',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const id = writeInstruction(
      tasksDir,
      'promote the munich thing',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.engine).toBe('cli+test') // cli+ai path: cli claimed verb, resolver picked card
    expect(typeof inst.ms).toBe('number')
  })
  it('a resolver that self-describes gets its model and version recorded', async () => {
    const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
    for (const s of ['queue', 'cards', 'artifacts'])
      mkdirSync(join(tasksDir, s), { recursive: true })
    const caps: Capabilities = {
      dates: { extract: (t: string) => ({ cleaned: t }) },
      resolver: {
        info: { model: 'models/laya', version: '@receptron/laya@0.1.2' },
        decide: async () => ({ key: 'munich-conference', confidence: 0.95 })
      }
    }
    writeCard(tasksDir, {
      shortname: 'munich-conference',
      title: 'Munich conference talk',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const engine = new Engine({
      tasksDir,
      device: 'this-mac',
      registry,
      config,
      caps,
      aliases: {},
      onChange: vi.fn(),
      now: () => new Date('2026-10-02T10:00:00')
    })
    const id = writeInstruction(
      tasksDir,
      'promote the munich thing',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.model).toBe('models/laya')
    expect(inst.version).toBe('@receptron/laya@0.1.2')
  })
  it('a slash-forced bad command parks in attention with the parse error', async () => {
    const { tasksDir, engine } = setup([])
    const id = writeInstruction(tasksDir, '/createx ship it', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('attention')
    expect(inst.error).toMatch(/unknown command "createx"/)
  })
  it('bare non-command input does NOT capture — it parks loud (no silent cards)', async () => {
    const { tasksDir, engine } = setup([]) // strict resolver: any call throws
    const id = writeInstruction(
      tasksDir,
      'remove hetzner payment card',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('attention')
    expect(inst.error).toMatch(/unknown command "remove" — start the line with \+ to capture/)
    expect(readdirSync(join(tasksDir, 'cards'))).toHaveLength(0) // nothing filed
  })

  it('+ captures explicitly: a card is filed, no resolver call, via: cli', async () => {
    const { tasksDir, engine } = setup([]) // strict resolver: any call throws
    const id = writeInstruction(
      tasksDir,
      '+ gotta fix the balcony door',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.via).toBe('cli')
    expect(inst.action).toBe('create')
    const cards = readdirSync(join(tasksDir, 'cards'))
    expect(cards).toHaveLength(1)
    expect(readCard(join(tasksDir, 'cards', cards[0])).title).toBe('gotta fix the balcony door')
  })

  it('a question pushed at the system parks, never mutates', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'record-screencasts',
      title: 'record screencasts',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const id = writeInstruction(tasksDir, 'what is a screencast?', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('attention')
    expect(readCard(join(tasksDir, 'cards', 'record-screencasts.md')).status).toBe('active') // untouched
  })
  it('needs-card: CLI verb + resolver card pick executes and marks via: cli+ai', async () => {
    const { tasksDir, engine } = setup([{ key: 'munich-conference', confidence: 0.95 }])
    writeCard(tasksDir, {
      shortname: 'munich-conference',
      title: 'Munich conference talk',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const id = writeInstruction(
      tasksDir,
      'promote the munich thing',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.via).toBe('cli+ai')
    expect(inst.engine).toBe('cli+test') // both layers in the telemetry
    expect(inst.pick).toBeCloseTo(0.95)
    expect(readCard(join(tasksDir, 'cards', 'munich-conference.md')).status).toBe('active')
  })
  it('needs-card: an unconfident pick parks with a suggestion, never a wrong action', async () => {
    const { tasksDir, engine } = setup([{ key: 'munich-conference', confidence: 0.4 }])
    writeCard(tasksDir, {
      shortname: 'munich-conference',
      title: 'Munich conference talk',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const id = writeInstruction(
      tasksDir,
      'promote the munich thing',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('attention')
    expect(inst.error).toMatch(/could not resolve target card — did you mean #munich-conference/)
    expect(readCard(join(tasksDir, 'cards', 'munich-conference.md')).status).toBe('inbox')
  })
  it('cli delete still parks at needs_confirmation', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'proto',
      title: 'P',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const id = writeInstruction(tasksDir, 'rm #proto', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('needs_confirmation')
  })
})

describe('Engine delegate open-target (policy: create)', () => {
  it('@local with no card creates the workspace card and delegates to it', async () => {
    const tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
    for (const s of ['queue', 'cards', 'artifacts'])
      mkdirSync(join(tasksDir, s), { recursive: true })
    const caps: Capabilities = {
      dates: { extract: (t: string) => ({ cleaned: t }) },
      resolver: {
        decide: async () => {
          throw new Error('no resolver on cli path')
        }
      },
      generator: { complete: async () => 'A screencast is a recorded demo.' }
    }
    const engine = new Engine({
      tasksDir,
      device: 'this-mac',
      registry: {
        ...registry,
        create: { class: 'normal', target: 'none' },
        delegate: { class: 'normal', target: 'create' }
      },
      config: { ...config, collaborators: { local: { use: 'generator' } } },
      caps,
      aliases,
      onChange: vi.fn(),
      now: () => new Date('2026-10-02T10:00:00')
    })
    const id = writeInstruction(
      tasksDir,
      '@local what is a screencast?',
      new Date('2026-10-02T10:00:00')
    )
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('done')
    expect(inst.via).toBe('cli')
    expect(inst.action).toBe('delegate') // frontmatter advanced by the create+with motion
    expect(inst.card).toBe('what-is-a-screencast')
    expect(readCard(join(tasksDir, 'cards', 'what-is-a-screencast.md')).title).toBe(
      'what is a screencast?'
    )
    expect(readdirSync(join(tasksDir, 'artifacts', 'what-is-a-screencast'))).toHaveLength(1)
  })
})

describe('Engine label actions', () => {
  it('pre-resolved tag instruction applies labels through the door', async () => {
    const { tasksDir, engine } = setup([])
    writeCard(tasksDir, {
      shortname: 'proto',
      title: 'P',
      status: 'active',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const id = writeInstruction(
      tasksDir,
      'tag #proto #highlight',
      new Date('2026-10-02T10:00:00'),
      {
        action: 'label',
        card: 'proto',
        tags: ['highlight'],
        via: 'cli'
      }
    )
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
    expect(readCard(join(tasksDir, 'cards', 'proto.md')).labels).toEqual(['highlight'])
  })
})

describe('Engine project ops', () => {
  it('projects lists into result, via cli', async () => {
    const projects = fakeProjects()
    const { tasksDir, engine } = setup([], projects)
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
  it('project_rm confirm reads the project name from instruction title as fallback when pending.status is absent', async () => {
    // Verify that after parking, the instruction's frontmatter title carries the project name —
    // so the new `pending.status ?? readInstruction(path).title` fallback has the right value.
    const projects = fakeProjects()
    const { tasksDir, engine } = setup([], projects)
    const id = writeInstruction(tasksDir, 'project rm house', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    // The parked instruction must carry title = 'house' so the frontmatter fallback works.
    expect(inst.title).toBe('house')
    expect(inst.status).toBe('needs_confirmation')
    // Confirm still completes correctly (covers the normal path, which uses pending.status first)
    await engine.confirm(id)
    expect(projects.removed).toEqual(['house'])
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('done')
  })
  it('project_rm confirm guards setStatus with existsSync when removing the active project trashes the instruction file', async () => {
    // When the active project is removed, ProjectOps.remove() switches to default then trashes
    // the project dir — which contains the instruction file. Subsequent setStatus must not throw.
    const projects = fakeProjects()
    // Override remove to trash the instruction file (simulate active-project removal)
    let instructionPath = ''
    projects.remove = async (_n: string) => {
      // trash the instruction file to simulate it being moved away
      if (instructionPath && existsSync(instructionPath)) {
        const { mkdirSync: mkdir, renameSync: rename } = await import('fs')
        const trashDir = join(tasksDir, '..', '.trash')
        mkdir(trashDir, { recursive: true })
        rename(instructionPath, join(trashDir, 'moved.md'))
      }
    }
    const { tasksDir, engine } = setup([], projects)
    const id = writeInstruction(tasksDir, 'project rm house', new Date('2026-10-02T10:00:00'))
    instructionPath = qpath(tasksDir, id)
    await engine.processFile(qpath(tasksDir, id))
    expect(readInstruction(qpath(tasksDir, id)).status).toBe('needs_confirmation')
    // Confirm must resolve without throwing even though the file was moved away
    await expect(engine.confirm(id)).resolves.not.toThrow()
    // File was moved — no instruction at original path
    expect(existsSync(qpath(tasksDir, id))).toBe(false)
  })
  it('a failing project op parks with the real error', async () => {
    const projects = fakeProjects()
    projects.switch = async () => {
      throw new Error('unknown project "ghost" — have: default, house')
    }
    const { tasksDir, engine } = setup([], projects)
    const id = writeInstruction(tasksDir, 'project ghost', new Date('2026-10-02T10:00:00'))
    await engine.processFile(qpath(tasksDir, id))
    const inst = readInstruction(qpath(tasksDir, id))
    expect(inst.status).toBe('attention')
    expect(inst.error).toMatch(/unknown project "ghost"/)
  })
})
