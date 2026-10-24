import { readFileSync, existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { ShapeMap } from './types'
import { textShape } from './text'
import { noteShape } from './note'
import { dateShape } from './date'
import { personShape } from './person'
import { outputShape } from './output'
import { logShape } from './log'

export const BUNDLED: ShapeMap = {
  text: textShape,
  note: noteShape,
  date: dateShape,
  person: personShape,
  output: outputShape,
  log: logShape,
}

type ElementTypeConfig = {
  schema: string
  section?: string
  lead?: boolean
  system?: boolean
  ops: string[]
}

/**
 * Read <tasksDir>/elements.json and return both the raw config map and the
 * resolved shapes for the enabled types.  Throws for any type key that has no
 * BUNDLED entry — no fallback.
 */
export function loadElements(tasksDir: string): {
  types: Record<string, ElementTypeConfig>
  shapes: ShapeMap
} {
  const path = join(tasksDir, 'elements.json')
  if (!existsSync(path)) throw new Error(`elements.json not found at ${path}`)
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, ElementTypeConfig>
  const shapes: ShapeMap = {}
  for (const type of Object.keys(raw)) {
    if (!BUNDLED[type])
      throw new Error(
        `elements.json references unknown element type "${type}" — no BUNDLED shape found`
      )
    shapes[type] = BUNDLED[type]
  }
  return { types: raw, shapes }
}

/**
 * Backfill a project's elements.json with any type keys the template defines
 * but this (possibly older) file is missing — mirrors reconcileRegistry.
 * Only ADDS missing keys; an entry the project already has is never touched.
 * Writes back only when something changed. Returns the keys added, empty when
 * nothing changed or the template is unreadable.
 */
export function reconcileElements(tasksDir: string, templatePath: string): string[] {
  const path = join(tasksDir, 'elements.json')
  if (!existsSync(path) || !existsSync(templatePath)) return []
  let current: Record<string, unknown>, tpl: Record<string, unknown>
  try {
    current = JSON.parse(readFileSync(path, 'utf-8'))
    tpl = JSON.parse(readFileSync(templatePath, 'utf-8'))
  } catch {
    return [] // half-written / invalid file is not ours to repair here
  }
  const added: string[] = []
  for (const k of Object.keys(tpl)) {
    if (!(k in current)) {
      current[k] = tpl[k]
      added.push(k)
    }
  }
  if (!added.length) return []
  writeFileSync(path, JSON.stringify(current, null, 2) + '\n')
  return added
}
