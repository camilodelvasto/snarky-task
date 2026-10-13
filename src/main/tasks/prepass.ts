import type { Dates } from '../capabilities/contracts'
import type { Registry } from './types'

export interface PrepassResult {
  meta?: string
  refs: string[]
  due?: string
  cleaned: string
}

export function prepass(raw: string, dates: Dates, now: Date, registry: Registry): PrepassResult {
  const trimmed = raw.trim()
  const metaKeys = Object.keys(registry).filter((k) => registry[k].class === 'meta')
  // Meta words are commands; honor the `/` command sigil on them too (`/clear`).
  const bare = trimmed.replace(/^\//, '').toLowerCase()
  if (metaKeys.includes(bare)) {
    return { meta: bare, refs: [], cleaned: trimmed }
  }
  const refs = [...trimmed.matchAll(/#([a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase())
  const { due, cleaned } = dates.extract(trimmed, now)
  return { refs, due, cleaned }
}
