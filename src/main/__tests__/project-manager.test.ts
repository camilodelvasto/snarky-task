// src/main/__tests__/project-manager.test.ts
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ProjectManager } from '../project-manager'
import { writeInstruction, readInstruction } from '../tasks/files'
import { createProject } from '../tasks/projects'

/** A directory containing only templates/default config + registry — simulates bundled app templates. */
function makeAppTemplatesDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'app-tpl-'))
  const dflt = join(dir, 'default')
  mkdirSync(dflt, { recursive: true })
  writeFileSync(join(dflt, 'config.json'), OFFLINE_CONFIG)
  writeFileSync(join(dflt, 'registry.json'), REGISTRY)
  return dir
}

const OFFLINE_CONFIG = JSON.stringify({
  resolver: { impl: 'ollama', host: 'http://127.0.0.1:1', model: 'x' },
  dates: { impl: 'chrono' },
  thresholds: { card: 0.6 },
  jobs: { max_parallel: 1 },
  confirmation_timeout_s: 1
})

const REGISTRY = JSON.stringify({
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
  clean: { class: 'meta' },
  clear: { class: 'meta' },
  project: { class: 'meta' },
  project_rm: { class: 'destructive' }
})

/** Build a legacy-layout root (workspace/tasks) for migration testing. */
function makeLegacyRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pm-'))
  const tasksDir = join(root, 'tasks')
  for (const s of ['queue', 'cards', 'history', 'artifacts'])
    mkdirSync(join(tasksDir, s), { recursive: true })
  writeFileSync(join(tasksDir, 'config.json'), OFFLINE_CONFIG)
  writeFileSync(join(tasksDir, 'registry.json'), REGISTRY)
  return root
}

/** Build a fresh root already in the new projects layout. */
function makeProjectsRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'pm-'))
  const tasksDir = join(root, 'projects', 'default', 'tasks')
  for (const s of ['queue', 'cards', 'history', 'artifacts'])
    mkdirSync(join(tasksDir, s), { recursive: true })
  writeFileSync(join(tasksDir, 'config.json'), OFFLINE_CONFIG)
  writeFileSync(join(tasksDir, 'registry.json'), REGISTRY)
  writeFileSync(join(root, 'current'), 'default\n')
  return root
}

const managers: ProjectManager[] = []

afterEach(async () => {
  for (const pm of managers.splice(0)) await pm.stop().catch(() => {})
})

describe('ProjectManager', () => {
  it('boot() migrates a legacy workspace/tasks layout to projects/default/tasks', async () => {
    const root = makeLegacyRoot()
    const pm = new ProjectManager(root, '', 'this-mac', () => {})
    managers.push(pm)
    await pm.boot()
    // migration happened: legacy tasks gone, projects/default/tasks exists
    expect(existsSync(join(root, 'tasks'))).toBe(false)
    expect(existsSync(join(root, 'projects', 'default', 'tasks'))).toBe(true)
    expect(pm.current()).toBe('default')
  })

  it('an instruction processed by the engine lands a card in projects/default/tasks/cards', async () => {
    const root = makeProjectsRoot()
    const pm = new ProjectManager(root, '', 'this-mac', () => {})
    managers.push(pm)
    await pm.boot()
    const id = writeInstruction(pm.getTasksDir(), '+ hello world', new Date('2026-10-02T10:00:00'))
    await pm.getEngine().processFile(join(pm.getTasksDir(), 'queue', `${id}.md`))
    const inst = readInstruction(join(pm.getTasksDir(), 'queue', `${id}.md`))
    expect(inst.status).toBe('done')
    // card must land in projects/default/tasks/cards
    expect(existsSync(join(root, 'projects', 'default', 'tasks', 'cards'))).toBe(true)
  })

  it('switch re-points getTasksDir() and new instructions land in the new project', async () => {
    const root = makeProjectsRoot()
    // Pre-create the 'house' project so we can switch to it
    const defaultTasksDir = join(root, 'projects', 'default', 'tasks')
    createProject(root, 'house', new Date('2026-10-01'))
    // house project needs config + registry (createProject copies from default)
    // but default already has them so the copy should have worked
    const pm = new ProjectManager(root, '', 'this-mac', () => {})
    managers.push(pm)
    await pm.boot()
    expect(pm.getTasksDir()).toBe(join(root, 'projects', 'default', 'tasks'))

    await pm.switch('house')
    expect(pm.getTasksDir()).toBe(join(root, 'projects', 'house', 'tasks'))
    expect(pm.current()).toBe('house')

    const id = writeInstruction(pm.getTasksDir(), '+ house task', new Date('2026-10-02T10:00:00'))
    await pm.getEngine().processFile(join(pm.getTasksDir(), 'queue', `${id}.md`))
    const inst = readInstruction(join(pm.getTasksDir(), 'queue', `${id}.md`))
    expect(inst.status).toBe('done')
    // card must be in house project, not default
    expect(existsSync(join(root, 'projects', 'house', 'tasks', 'cards'))).toBe(true)
    // default tasksDir is still the old one (confirm it's a separate dir)
    expect(pm.getTasksDir()).not.toBe(defaultTasksDir)
  })

  it('pm.stop() closes cleanly', async () => {
    const root = makeProjectsRoot()
    const pm = new ProjectManager(root, '', 'this-mac', () => {})
    await pm.boot()
    await expect(pm.stop()).resolves.not.toThrow()
  })

  it('boot() copies templates from appTemplatesDir when root has no templates/', async () => {
    // Root has projects/default/tasks but no templates/ dir
    const root = makeProjectsRoot()
    const appTplDir = makeAppTemplatesDir()
    expect(existsSync(join(root, 'templates'))).toBe(false)
    const pm = new ProjectManager(root, appTplDir, 'this-mac', () => {})
    managers.push(pm)
    await pm.boot()
    // templates/default must now exist in the root
    expect(existsSync(join(root, 'templates', 'default', 'config.json'))).toBe(true)
  })

  it('boot() does not overwrite an existing templates/ dir', async () => {
    const root = makeProjectsRoot()
    const appTplDir = makeAppTemplatesDir()
    // Manually create templates/default with a sentinel value
    const tplDefault = join(root, 'templates', 'default')
    mkdirSync(tplDefault, { recursive: true })
    writeFileSync(join(tplDefault, 'config.json'), '{"sentinel":true}')
    const pm = new ProjectManager(root, appTplDir, 'this-mac', () => {})
    managers.push(pm)
    await pm.boot()
    // Must NOT overwrite
    const content = JSON.parse(readFileSync(join(tplDefault, 'config.json'), 'utf-8'))
    expect(content.sentinel).toBe(true)
  })

  it('remove() active project switches to default, trashes dir, confirm resolves without throwing', async () => {
    const root = makeProjectsRoot()
    // Create a second project to act as "active" to remove
    createProject(root, 'to-remove', new Date('2026-10-01'))
    const pm = new ProjectManager(root, '', 'this-mac', () => {})
    managers.push(pm)
    await pm.boot()
    // Switch to the project we'll remove
    await pm.switch('to-remove')
    expect(pm.current()).toBe('to-remove')
    // Now remove it — should switch to default, trash the dir, not throw
    await expect(pm.remove('to-remove')).resolves.not.toThrow()
    // Switched back to default
    expect(pm.current()).toBe('default')
    // The project directory is gone (moved to .trash)
    expect(existsSync(join(root, 'projects', 'to-remove'))).toBe(false)
  })
})
