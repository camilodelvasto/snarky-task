import { watch, type FSWatcher } from 'chokidar'
import { join } from 'path'
import { Engine } from './tasks/engine'
import { loadConfig } from './tasks/config'
import { loadRegistry, reconcileRegistry } from './tasks/registry'
import { reconcileElements } from './tasks/elements/registry'
import { writeInstruction, patchInstruction } from './tasks/files'
import { bindCapabilities } from './capabilities/bind'
import {
  migrateWorkspace,
  ensureDefaultProject,
  listProjects,
  listTemplates,
  currentProject,
  writeCurrent,
  projectTasksDir,
  ensureProjectDirs,
  createProject,
  trashProject,
  syncBundledTemplates
} from './tasks/projects'
import type { ProjectOps, TaskdeckConfig } from './tasks/types'

export class ProjectManager implements ProjectOps {
  private engine!: Engine
  private cfg!: TaskdeckConfig
  private name!: string
  private watcher?: FSWatcher
  private onChange: () => void
  constructor(
    private root: string,
    private appTemplatesDir: string,
    private device: string,
    onChange: () => void
  ) {
    this.onChange = onChange
  }

  async boot(): Promise<void> {
    // Backfill missing bundled template files into root/templates/ (e.g. elements.json
    // added in Task 7 that pre-existing workspaces never received). Never overwrites
    // existing files so user-customised templates are always safe. Also handles the
    // "no templates/ at all" case for workspaces pointing at an off-repo dir.
    syncBundledTemplates(this.root, this.appTemplatesDir)
    migrateWorkspace(this.root)
    // C1: ensure the default project always has config/registry (brick guard)
    ensureDefaultProject(this.root)
    await this.bind(currentProject(this.root))
    // Hand edits / git pulls to `current` are first-class switches.
    this.watcher = watch(join(this.root, 'current'), { ignoreInitial: true })
    const onCurrentChange = (): void => {
      const want = currentProject(this.root)
      if (want !== this.name)
        void this.switch(want).catch((err) => console.error('project switch:', err))
    }
    this.watcher.on('change', onCurrentChange)
    // Also handle 'add': current file created after boot (deleted+recreated, or synced in)
    this.watcher.on('add', onCurrentChange)
  }

  private async bind(name: string): Promise<void> {
    const tasksDir = projectTasksDir(this.root, name)
    // A synced project may arrive missing its empty subdirs (Syncthing) — recreate
    // them locally before the engine reads/writes the queue, cards, history, artifacts.
    ensureProjectDirs(tasksDir)
    // Stale-deck repair: backfill any core verbs/aliases this (possibly older)
    // project registry is missing from the default template, so a verb added
    // after the deck was created doesn't park loud forever. Runs before the
    // registry is read; a logged notice (below) makes the change visible.
    const added = reconcileRegistry(
      tasksDir,
      join(this.root, 'templates', 'default', 'registry.json')
    )
    const addedElements = reconcileElements(
      tasksDir,
      join(this.root, 'templates', 'default', 'elements.json')
    )
    const config = loadConfig(tasksDir) // throws → caller parks the switch; old engine still running
    const { registry, aliases } = loadRegistry(tasksDir)
    const caps = bindCapabilities(config)
    const next = new Engine({
      tasksDir,
      device: this.device,
      registry,
      config,
      caps,
      aliases,
      onChange: this.onChange,
      projects: this
    })
    // Log the reconciliation to the feed as a done row (written before the new
    // engine starts so its boot scan sees it already-done and starts its TTL —
    // it sweeps like any other done instruction, never re-processed).
    const allAdded = [
      ...added,
      ...addedElements.map((k) => `element:${k}`)
    ]
    if (allAdded.length) {
      const id = writeInstruction(tasksDir, `registry reconciled (${name})`, new Date())
      patchInstruction(join(tasksDir, 'queue', `${id}.md`), {
        status: 'done',
        action: 'reconcile',
        engine: 'cli',
        via: 'cli',
        device: this.device,
        result: `backfilled from the default template: ${allAdded.join(', ')}`
      })
    }
    if (this.engine) await this.engine.stop()
    this.engine = next
    this.cfg = config
    this.name = name
    next.start()
    this.onChange()
  }

  // ProjectOps
  list(): string[] {
    return listProjects(this.root)
  }
  templates(): string[] {
    return listTemplates(this.root)
  }
  current(): string {
    return this.name
  }

  async switch(name: string): Promise<void> {
    if (name === this.name) return
    await this.bind(name) // bind first — a broken project must not half-switch
    writeCurrent(this.root, name)
  }

  async create(name: string, template?: string): Promise<void> {
    createProject(this.root, name, new Date(), template)
  }

  async remove(name: string): Promise<void> {
    if (name === this.name) await this.switch('default')
    trashProject(this.root, name, new Date())
    this.onChange()
  }

  // accessors for the server (Task 4)
  getEngine(): Engine {
    return this.engine
  }
  getTasksDir(): string {
    return projectTasksDir(this.root, this.name)
  }
  getUi(): TaskdeckConfig['ui'] {
    return this.cfg.ui
  }

  async stop(): Promise<void> {
    await this.watcher?.close()
    await this.engine.stop()
  }
}
