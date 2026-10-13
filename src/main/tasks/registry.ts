import { readFileSync, existsSync } from 'fs'
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
