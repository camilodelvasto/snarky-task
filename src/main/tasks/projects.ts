import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  copyFileSync
} from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { readCard, writeCard } from './files'

export const PROJECT_SLUG = /^[a-z0-9-]+$/

/**
 * Workspace root resolution, in order:
 * 1. XWEB_WORKSPACE env var when set
 * 2. first line of ~/.config/snarky-task/root when it names an existing
 *    directory (trimmed, ~ expanded; stale pointer warns and falls through)
 * 3. join(appRoot, 'workspace')
 */
export function resolveRoot(
  appRoot: string,
  env: string | undefined = process.env.XWEB_WORKSPACE,
  cfgPath: string = join(homedir(), '.config', 'snarky-task', 'root')
): string {
  if (env) return env
  if (existsSync(cfgPath)) {
    const first = readFileSync(cfgPath, 'utf-8').split('\n')[0].trim()
    const expanded = first.startsWith('~') ? join(homedir(), first.slice(1)) : first
    if (expanded && existsSync(expanded)) return expanded
    console.warn(`resolveRoot: ${cfgPath} points at missing directory "${expanded}" — falling back`)
  }
  return join(appRoot, 'workspace')
}
const stamp = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ')

export const projectTasksDir = (root: string, name: string): string =>
  join(root, 'projects', name, 'tasks')

export function migrateWorkspace(root: string): boolean {
  const legacy = join(root, 'tasks')
  const projects = join(root, 'projects')
  if (!existsSync(legacy) || existsSync(projects)) {
    // Fresh-clone bootstrap: no tasks/ and no projects/, but templates/default/ exists →
    // scaffold projects/default/tasks from the template and write current.
    if (!existsSync(legacy) && !existsSync(projects)) {
      const tplDefault = join(root, 'templates', 'default')
      if (existsSync(tplDefault)) {
        const tasks = projectTasksDir(root, 'default')
        for (const s of ['queue', 'cards', 'history', 'artifacts'])
          mkdirSync(join(tasks, s), { recursive: true })
        for (const f of ['config.json', 'registry.json']) {
          const src = join(tplDefault, f)
          if (existsSync(src)) copyFileSync(src, join(tasks, f))
        }
        writeFileSync(join(root, 'current'), 'default\n')
        return true
      }
    }
    return false
  }
  mkdirSync(join(projects, 'default'), { recursive: true })
  renameSync(legacy, projectTasksDir(root, 'default'))
  writeFileSync(join(root, 'current'), 'default\n')
  return true
}

/**
 * Brick guard: ensures projects/default/tasks has all four subdirs and both json files.
 * Missing files are backfilled from templates/default/. If a file is missing from BOTH,
 * throws a clear error (no silent degradation — better a loud boot error than a brick).
 * Safe to call on every boot; only writes when something is missing.
 */
export function ensureDefaultProject(root: string): void {
  const tasks = projectTasksDir(root, 'default')
  // Ensure subdirs exist
  for (const s of ['queue', 'cards', 'history', 'artifacts'])
    mkdirSync(join(tasks, s), { recursive: true })
  const tplDefault = join(root, 'templates', 'default')
  for (const f of ['config.json', 'registry.json']) {
    const dest = join(tasks, f)
    if (!existsSync(dest)) {
      const src = join(tplDefault, f)
      if (!existsSync(src))
        throw new Error(
          `ensureDefaultProject: ${f} is missing from projects/default/tasks and from templates/default — cannot boot`
        )
      copyFileSync(src, dest)
    }
  }
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
  if (!PROJECT_SLUG.test(name))
    throw new Error(`project name must be a slug ([a-z0-9-]): "${name}"`)
  if (listProjects(root).includes(name)) throw new Error(`project "${name}" already exists`)
  if (template && !listTemplates(root).includes(template))
    throw new Error(
      `unknown template "${template}" — have: ${listTemplates(root).join(', ') || 'none'}`
    )
  const tasks = projectTasksDir(root, name)
  for (const s of ['queue', 'cards', 'history', 'artifacts'])
    mkdirSync(join(tasks, s), { recursive: true })
  const tplDir = template ? join(root, 'templates', template) : undefined
  const defaults = projectTasksDir(root, 'default')
  const tplDefault = join(root, 'templates', 'default')
  for (const f of ['config.json', 'registry.json']) {
    const fromTpl = tplDir && existsSync(join(tplDir, f)) ? join(tplDir, f) : undefined
    const fromDefault = existsSync(join(defaults, f)) ? join(defaults, f) : undefined
    const fromTplDefault = existsSync(join(tplDefault, f)) ? join(tplDefault, f) : undefined
    const src = fromTpl ?? fromDefault ?? fromTplDefault
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
