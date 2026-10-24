import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Registry, RegistryAliases } from './types'

const CLASSES = ['normal', 'destructive', 'meta']
const TARGETS = ['none', 'resolve', 'create', 'required']

export function loadRegistry(tasksDir: string): { registry: Registry; aliases: RegistryAliases } {
  const path = join(tasksDir, 'registry.json')
  if (!existsSync(path)) throw new Error(`registry.json not found at ${path}`)
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  const { aliases = {}, ...registry } = raw as Record<string, unknown> & {
    aliases?: RegistryAliases
  }
  for (const [key, entry] of Object.entries(registry)) {
    const e = entry as { class?: string; target?: string }
    if (!CLASSES.includes(e.class ?? ''))
      throw new Error(`registry entry "${key}" has unknown class "${e.class}"`)
    if (e.target !== undefined && !TARGETS.includes(e.target))
      throw new Error(`registry entry "${key}" has unknown target "${e.target}"`)
  }
  return { registry: registry as Registry, aliases }
}

/**
 * Backfill a project's registry with any action entries and alias keys the
 * template defines but this (possibly older) registry is missing — the fix for
 * stale decks created before a core verb existed, which would otherwise park
 * that verb loud forever. Only ADDS missing keys; an entry the project already
 * has (even one hand-customized to differ from the template) is never touched.
 * Writes back only when something changed. Returns the keys added (alias keys as
 * `alias:<name>`), empty when nothing changed or the template is unreadable.
 */
export function reconcileRegistry(tasksDir: string, templatePath: string): string[] {
  const path = join(tasksDir, 'registry.json')
  if (!existsSync(path) || !existsSync(templatePath)) return []
  let r: Record<string, unknown>, tpl: Record<string, unknown>
  try {
    r = JSON.parse(readFileSync(path, 'utf-8'))
    tpl = JSON.parse(readFileSync(templatePath, 'utf-8'))
  } catch {
    return [] // a half-written/invalid file is not ours to repair here
  }
  const { aliases: tAliases = {}, ...tActions } = tpl as {
    aliases?: RegistryAliases
  } & Record<string, unknown>
  const added: string[] = []
  const rAliases = (r.aliases && typeof r.aliases === 'object' ? r.aliases : {}) as RegistryAliases
  for (const k of Object.keys(tAliases))
    if (!(k in rAliases)) {
      rAliases[k] = tAliases[k]
      added.push(`alias:${k}`)
    }
  for (const k of Object.keys(tActions))
    if (!(k in r)) {
      r[k] = tActions[k]
      added.push(k)
    }
  if (!added.length) return []
  if (added.some((a) => a.startsWith('alias:'))) r.aliases = rAliases
  writeFileSync(path, JSON.stringify(r, null, 2) + '\n')
  return added
}
