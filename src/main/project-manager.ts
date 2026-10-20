import { watch, type FSWatcher } from 'chokidar'
import { join } from 'path'
import { cpSync, existsSync } from 'fs'
import { Engine } from './tasks/engine'
import { loadConfig } from './tasks/config'
import { loadRegistry } from './tasks/registry'
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
  trashProject
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
    // I3: copy bundled templates into root if root has no templates/ yet
    // (happens when a user points ~/.config/snarky-task/root at an off-repo dir)
    if (
      this.appTemplatesDir &&
      !existsSync(join(this.root, 'templates')) &&
      existsSync(this.appTemplatesDir)
    ) {
      cpSync(this.appTemplatesDir, join(this.root, 'templates'), { recursive: true })
    }
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
