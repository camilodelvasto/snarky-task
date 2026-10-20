import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { TaskdeckConfig } from './types'

const REQUIRED: Array<keyof TaskdeckConfig> = [
  'resolver',
  'dates',
  'thresholds',
  'jobs',
  'confirmation_timeout_s'
]

export function loadConfig(tasksDir: string): TaskdeckConfig {
  const path = join(tasksDir, 'config.json')
  if (!existsSync(path)) throw new Error(`config.json not found at ${path}`)
  const raw = JSON.parse(readFileSync(path, 'utf-8'))
  for (const key of REQUIRED) {
    if (raw[key] === undefined) throw new Error(`config.json missing required field: ${key}`)
  }
  if (typeof raw.thresholds.card !== 'number')
    throw new Error('config.json missing required field: thresholds.card')
  for (const t of ['action', 'status'])
    if (raw.thresholds[t] !== undefined)
      console.warn(`config.json thresholds.${t} is obsolete (slot resolution) — ignored`)
  return raw as TaskdeckConfig
}
