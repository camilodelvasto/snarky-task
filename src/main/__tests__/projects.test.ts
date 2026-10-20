import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  resolveRoot,
  resolveDevice,
  migrateWorkspace,
  listProjects,
  listTemplates,
  currentProject,
  writeCurrent,
  projectTasksDir,
  createProject,
  trashProject,
  ensureDefaultProject,
  ensureProjectDirs
} from '../tasks/projects'
import { writeCard, readCard } from '../tasks/files'

const now = new Date('2026-10-15T10:00:00Z')

function root(): string {
  return mkdtempSync(join(tmpdir(), 'td-root-'))
}
/** A root with a default project carrying config+registry (the post-migration shape). */
function seeded(): string {
  const r = root()
  const t = join(r, 'projects', 'default', 'tasks')
  for (const s of ['queue', 'cards', 'history', 'artifacts'])
    mkdirSync(join(t, s), { recursive: true })
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
  it('no legacy tasks + projects/ exists → returns false', () => {
    const r = seeded()
    // projects/ exists, so migrateWorkspace is a no-op
    expect(migrateWorkspace(r)).toBe(false)
  })
  it('fresh-clone bootstrap: empty root with only templates/default → scaffolds working default project', () => {
    const r = root()
    // Set up templates/default with config + registry (fresh clone has these tracked)
    const tpl = join(r, 'templates', 'default')
    mkdirSync(tpl, { recursive: true })
    writeFileSync(join(tpl, 'config.json'), '{"resolver":{"impl":"ollama"}}')
    writeFileSync(join(tpl, 'registry.json'), '{"create":{"class":"normal"}}')
    // No tasks/ and no projects/ — pure fresh-clone state
    expect(existsSync(join(r, 'tasks'))).toBe(false)
    expect(existsSync(join(r, 'projects'))).toBe(false)
    expect(migrateWorkspace(r)).toBe(true)
    const tasks = join(r, 'projects', 'default', 'tasks')
    expect(existsSync(join(tasks, 'config.json'))).toBe(true)
    expect(existsSync(join(tasks, 'registry.json'))).toBe(true)
    for (const s of ['queue', 'cards', 'history', 'artifacts'])
      expect(existsSync(join(tasks, s))).toBe(true)
    expect(readFileSync(join(r, 'current'), 'utf-8').trim()).toBe('default')
    // Second call is a no-op (projects/ now exists)
    expect(migrateWorkspace(r)).toBe(false)
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
    for (const s of ['queue', 'cards', 'history', 'artifacts'])
      expect(existsSync(join(t, s))).toBe(true)
    expect(JSON.parse(readFileSync(join(t, 'config.json'), 'utf-8')).resolver.impl).toBe('x')
    expect(() => createProject(r, 'house', now)).toThrow(/already exists/)
    expect(() => createProject(r, 'Bad Name', now)).toThrow(/slug/)
    expect(() => createProject(r, 'x', now, 'ghost')).toThrow(/unknown template "ghost"/)
  })
  it('createProject falls back to templates/default/ for config/registry when projects/default lacks them', () => {
    const r = root()
    // projects/default/tasks exists but has NO config.json or registry.json
    const defaultTasks = join(r, 'projects', 'default', 'tasks')
    for (const s of ['queue', 'cards', 'history', 'artifacts'])
      mkdirSync(join(defaultTasks, s), { recursive: true })
    // templates/default has the config/registry
    const tplDefault = join(r, 'templates', 'default')
    mkdirSync(tplDefault, { recursive: true })
    writeFileSync(join(tplDefault, 'config.json'), '{"resolver":{"impl":"tpl-default"}}')
    writeFileSync(join(tplDefault, 'registry.json'), '{"create":{"class":"normal"}}')
    createProject(r, 'house', now)
    const t = projectTasksDir(r, 'house')
    expect(JSON.parse(readFileSync(join(t, 'config.json'), 'utf-8')).resolver.impl).toBe(
      'tpl-default'
    )
  })
  it('createProject from a template seeds cards with reset created/log', () => {
    const r = seeded()
    const tpl = join(r, 'templates', 'gtd', 'cards')
    mkdirSync(tpl, { recursive: true })
    writeCard(join(r, 'templates', 'gtd'), {
      shortname: 'capture-everything',
      title: 'Capture everything',
      status: 'inbox',
      created: '2020-01-01',
      links: [],
      labels: ['howto'],
      description: 'If it is on your mind, it goes here.',
      log: ['2020-01-01 00:00 — created']
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

describe('ensureProjectDirs', () => {
  it('creates the four task subdirs (recovering Syncthing-dropped empties)', () => {
    const tasks = join(mkdtempSync(join(tmpdir(), 'td-')), 'proj', 'tasks')
    mkdirSync(tasks, { recursive: true }) // tasks dir exists (synced files) but no subdirs
    ensureProjectDirs(tasks)
    for (const s of ['queue', 'cards', 'history', 'artifacts'])
      expect(existsSync(join(tasks, s))).toBe(true)
  })
})

describe('ensureDefaultProject', () => {
  it('backfills missing config.json from templates/default when projects/default/tasks exists without it', () => {
    const r = root()
    // projects/default/tasks exists but has NO config.json or registry.json
    const tasks = join(r, 'projects', 'default', 'tasks')
    for (const s of ['queue', 'cards', 'history', 'artifacts'])
      mkdirSync(join(tasks, s), { recursive: true })
    // templates/default has the config/registry
    const tplDefault = join(r, 'templates', 'default')
    mkdirSync(tplDefault, { recursive: true })
    writeFileSync(join(tplDefault, 'config.json'), '{"resolver":{"impl":"from-tpl"}}')
    writeFileSync(join(tplDefault, 'registry.json'), '{"create":{"class":"normal"}}')
    // config.json is absent — ensureDefaultProject must backfill it
    expect(existsSync(join(tasks, 'config.json'))).toBe(false)
    ensureDefaultProject(r)
    expect(existsSync(join(tasks, 'config.json'))).toBe(true)
    expect(existsSync(join(tasks, 'registry.json'))).toBe(true)
    expect(readFileSync(join(tasks, 'config.json'), 'utf-8')).toContain('from-tpl')
  })

  it('leaves existing config/registry intact (no overwrite)', () => {
    const r = root()
    const tasks = join(r, 'projects', 'default', 'tasks')
    for (const s of ['queue', 'cards', 'history', 'artifacts'])
      mkdirSync(join(tasks, s), { recursive: true })
    writeFileSync(join(tasks, 'config.json'), '{"resolver":{"impl":"existing"}}')
    writeFileSync(join(tasks, 'registry.json'), '{"create":{"class":"normal"}}')
    const tplDefault = join(r, 'templates', 'default')
    mkdirSync(tplDefault, { recursive: true })
    writeFileSync(join(tplDefault, 'config.json'), '{"resolver":{"impl":"from-tpl"}}')
    ensureDefaultProject(r)
    // Must NOT overwrite
    expect(readFileSync(join(tasks, 'config.json'), 'utf-8')).toContain('existing')
  })

  it('throws a clear error when config.json is missing in both tasks and templates/default', () => {
    const r = root()
    const tasks = join(r, 'projects', 'default', 'tasks')
    for (const s of ['queue', 'cards', 'history', 'artifacts'])
      mkdirSync(join(tasks, s), { recursive: true })
    // No templates/default at all
    expect(() => ensureDefaultProject(r)).toThrow(/config\.json/)
  })

  it('creates the four subdirs if they are absent', () => {
    const r = root()
    // Only tasks dir itself exists, no subdirs
    const tasks = join(r, 'projects', 'default', 'tasks')
    mkdirSync(tasks, { recursive: true })
    const tplDefault = join(r, 'templates', 'default')
    mkdirSync(tplDefault, { recursive: true })
    writeFileSync(join(tplDefault, 'config.json'), '{}')
    writeFileSync(join(tplDefault, 'registry.json'), '{}')
    ensureDefaultProject(r)
    for (const s of ['queue', 'cards', 'history', 'artifacts'])
      expect(existsSync(join(tasks, s))).toBe(true)
  })
})

describe('resolveDevice', () => {
  it('writes <host>-<hex> on first boot and returns the same id after', () => {
    const cfg = join(mkdtempSync(join(tmpdir(), 'dev-')), 'snarky-task', 'device')
    const id = resolveDevice(cfg)
    expect(id).toMatch(/^[a-z0-9-]+-[0-9a-f]{4}$/)
    expect(readFileSync(cfg, 'utf-8').trim()).toBe(id)
    expect(resolveDevice(cfg)).toBe(id)
  })

  it('reads a hand-written id', () => {
    const cfg = join(mkdtempSync(join(tmpdir(), 'dev-')), 'device')
    writeFileSync(cfg, 'camilo-mbp\n')
    expect(resolveDevice(cfg)).toBe('camilo-mbp')
  })

  it('throws on an empty file', () => {
    const cfg = join(mkdtempSync(join(tmpdir(), 'dev-')), 'device')
    writeFileSync(cfg, '\n')
    expect(() => resolveDevice(cfg)).toThrow(/is empty/)
  })
})

describe('resolveRoot', () => {
  it('prefers XWEB_WORKSPACE env when set', () => {
    expect(resolveRoot('/app', '/elsewhere/ws', '/no/such/cfg')).toBe('/elsewhere/ws')
  })
  it('uses the pointer file when it names an existing directory', () => {
    const target = root()
    const cfg = join(root(), 'root')
    writeFileSync(cfg, `  ${target}  \nsecond line ignored\n`)
    expect(resolveRoot('/app', undefined, cfg)).toBe(target)
  })
  it('falls back to appRoot/workspace when env unset and pointer stale or absent', () => {
    const cfg = join(root(), 'root')
    writeFileSync(cfg, '/no/such/dir\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(resolveRoot('/app', undefined, cfg)).toBe(join('/app', 'workspace'))
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
    expect(resolveRoot('/app', undefined, '/no/such/cfg')).toBe(join('/app', 'workspace'))
  })
})
