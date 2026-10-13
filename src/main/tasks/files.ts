import matter from 'gray-matter'
import { readFileSync, writeFileSync, appendFileSync } from 'fs'
import { join, basename } from 'path'
import { randomBytes } from 'crypto'
import type { Card, Instruction } from './types'

export function slugify(title: string, taken: Set<string>): string {
  const full = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  // Cap at a word boundary — a slug cut mid-word reads like a bug
  const capped =
    full.length <= 48
      ? full
      : full
          .slice(0, 48)
          .replace(/-[^-]*$/, '')
          .replace(/-+$/, '')
  const base = capped || full.slice(0, 48) || 'card'
  if (!taken.has(base)) return base
  let n = 2
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

export function writeInstruction(
  tasksDir: string,
  text: string,
  now: Date,
  // A deterministic surface action (board drop, button) already knows what it means —
  // its resolution rides along in frontmatter and the engine skips split/resolve.
  resolved?: {
    action: string
    card?: string
    to?: string
    title?: string
    desc?: string
    tags?: string[]
    due?: string
    with?: string
    via?: 'cli' | 'ai' | 'cli+ai'
  }
): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const id = `${stamp}-${randomBytes(2).toString('hex')}`
  const data: Record<string, unknown> = { status: 'queued' }
  if (resolved) {
    data.action = resolved.action
    if (resolved.card) data.card = resolved.card
    if (resolved.to) data.to = resolved.to
    if (resolved.title) data.title = resolved.title
    if (resolved.desc) data.desc = resolved.desc
    if (resolved.tags && resolved.tags.length > 0) data.tags = resolved.tags
    if (resolved.due) data.due = resolved.due
    if (resolved.with) data.with = resolved.with
    if (resolved.via) data.via = resolved.via
  }
  const content = matter.stringify(`\n${text}\n`, data)
  writeFileSync(join(tasksDir, 'queue', `${id}.md`), content)
  return id
}

export function readInstruction(path: string): Instruction {
  const { data, content } = matter(readFileSync(path, 'utf-8'))
  return {
    id: basename(path, '.md'),
    path,
    status: data.status,
    action: data.action ?? undefined,
    card: data.card ?? undefined,
    to: data.to ?? undefined,
    title: data.title ?? undefined,
    desc: data.desc ?? undefined,
    tags: data.tags ?? undefined,
    due: data.due ?? undefined,
    with: data.with ?? undefined,
    via: data.via ?? undefined,
    engine: data.engine ?? undefined,
    model: data.model ?? undefined,
    version: data.version ?? undefined,
    ms: data.ms ?? undefined,
    pick: data.pick ?? undefined,
    error: data.error ?? undefined,
    raw: content.trim()
  }
}

export function patchInstruction(
  path: string,
  patch: Partial<
    Pick<
      Instruction,
      | 'status'
      | 'action'
      | 'card'
      | 'to'
      | 'error'
      | 'via'
      | 'engine'
      | 'model'
      | 'version'
      | 'ms'
      | 'pick'
      | 'title'
      | 'desc'
      | 'tags'
      | 'due'
      | 'with'
    >
  >
): void {
  const { data, content } = matter(readFileSync(path, 'utf-8'))
  const merged = { ...data, ...patch }
  // Remove undefined values as js-yaml throws on them
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
  writeFileSync(path, matter.stringify(content, merged))
}

const LOG_HEADER = '## Log'

export function writeCard(tasksDir: string, card: Omit<Card, 'path' | 'artifacts'>): string {
  const path = join(tasksDir, 'cards', `${card.shortname}.md`)
  const front = {
    title: card.title,
    status: card.status,
    created: card.created,
    ...(card.due ? { due: card.due } : {}),
    links: card.links,
    labels: card.labels
  }
  const body = `\n${card.description}\n\n${LOG_HEADER}\n${card.log.map((l) => `- ${l}`).join('\n')}\n`
  writeFileSync(path, matter.stringify(body, front))
  return path
}

export function readCard(path: string): Card {
  const { data, content } = matter(readFileSync(path, 'utf-8'))
  const [desc, logPart] = content.split(LOG_HEADER)
  const log = (logPart ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2))
  return {
    shortname: basename(path, '.md'),
    path,
    title: data.title,
    status: data.status,
    created: String(data.created),
    due: data.due ? String(data.due) : undefined,
    links: data.links ?? [],
    labels: data.labels ?? [],
    description: desc.trim(),
    log,
    artifacts: [] // populated by readSnapshot via listArtifacts
  }
}

export function appendLog(cardPath: string, line: string): void {
  appendFileSync(cardPath, `- ${line}\n`)
}
