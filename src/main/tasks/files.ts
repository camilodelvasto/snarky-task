import matter from 'gray-matter'
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'fs'
import { join, basename, dirname } from 'path'
import { randomBytes } from 'crypto'
import type { Card, Instruction } from './types'
import { validateCard, validateInstruction, formatErrors } from './validate'

export function writeFileAtomic(path: string, data: string): void {
  // The parent dir may be missing on a synced workspace (Syncthing drops empty
  // dirs); guarantee it before writing so a write never ENOENTs.
  mkdirSync(dirname(path), { recursive: true })
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(3).toString('hex')}.tmp`)
  writeFileSync(tmp, data)
  renameSync(tmp, path)
}

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
    scope?: string
    via?: 'cli' | 'ai' | 'cli+ai'
  }
): string {
  const stamp = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const id = `${stamp}-${randomBytes(2).toString('hex')}`
  const data: Record<string, unknown> = { v: 1, status: 'queued' }
  if (resolved) {
    data.action = resolved.action
    if (resolved.card) data.card = resolved.card
    if (resolved.to) data.to = resolved.to
    if (resolved.title) data.title = resolved.title
    if (resolved.desc) data.desc = resolved.desc
    if (resolved.tags && resolved.tags.length > 0) data.tags = resolved.tags
    if (resolved.due) data.due = resolved.due
    if (resolved.with) data.with = resolved.with
    if (resolved.scope) data.scope = resolved.scope
    if (resolved.via) data.via = resolved.via
  }
  const errs = validateInstruction(data)
  if (errs.length) throw new Error(`instruction invalid: ${formatErrors(errs)}`)
  const content = matter.stringify(`\n${text}\n`, data)
  writeFileAtomic(join(tasksDir, 'queue', `${id}.md`), content)
  return id
}

export function readInstruction(path: string): Instruction {
  const { data, content } = matter(readFileSync(path, 'utf-8'))
  const errs = validateInstruction(data)
  if (errs.length)
    throw new Error(`${path} invalid against instruction.v1.json: ${formatErrors(errs)}`)
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
    scope: data.scope ?? undefined,
    via: data.via ?? undefined,
    engine: data.engine ?? undefined,
    model: data.model ?? undefined,
    version: data.version ?? undefined,
    ms: data.ms ?? undefined,
    pick: data.pick ?? undefined,
    error: data.error ?? undefined,
    result: data.result ?? undefined,
    device: data.device ?? undefined,
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
      | 'scope'
      | 'result'
      | 'device'
    >
  >
): void {
  const { data, content } = matter(readFileSync(path, 'utf-8'))
  const merged: Record<string, unknown> = { ...data, ...patch }
  // Remove undefined values as js-yaml throws on them
  for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k]
  merged.v = merged.v ?? 1
  const errs = validateInstruction(merged)
  if (errs.length) throw new Error(`instruction patch invalid: ${formatErrors(errs)}`)
  writeFileAtomic(path, matter.stringify(content, merged))
}

const LOG_HEADER = '## Log'
const NOTES_HEADER = '## Notes'

export function writeCard(
  tasksDir: string,
  card: Omit<Card, 'path' | 'artifacts' | 'notes'> & { notes?: string[] }
): string {
  const path = join(tasksDir, 'cards', `${card.shortname}.md`)
  const front = {
    v: 1,
    title: card.title,
    status: card.status,
    created: card.created,
    ...(card.due ? { due: card.due } : {}),
    links: card.links,
    labels: card.labels
  }
  const errs = validateCard(front)
  if (errs.length) throw new Error(`card "${card.shortname}" invalid: ${formatErrors(errs)}`)
  // Sections, in order: description, user notes (omitted when empty), system log.
  // The log is ALWAYS last so appendLog can append a line to EOF and land in it.
  const notes = card.notes ?? []
  const notesBlock = notes.length
    ? `${NOTES_HEADER}\n${notes.map((l) => `- ${l}`).join('\n')}\n\n`
    : ''
  const body = `\n${card.description}\n\n${notesBlock}${LOG_HEADER}\n${card.log.map((l) => `- ${l}`).join('\n')}\n`
  writeFileAtomic(path, matter.stringify(body, front))
  return path
}

/** Parse the `- ` bullet lines out of one card-body section. */
function bulletLines(section: string): string[] {
  return section
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2))
}

/** Split on a header that occupies a whole line (line-anchored). */
function splitSection(text: string, header: string): [string, string | undefined] {
  const m = text.match(new RegExp(`^${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm'))
  if (!m || m.index === undefined) return [text, undefined]
  return [text.slice(0, m.index), text.slice(m.index + m[0].length)]
}

export function readCard(path: string): Card {
  const { data, content } = matter(readFileSync(path, 'utf-8'))
  const errs = validateCard(data)
  if (errs.length) throw new Error(`${path} invalid against card.v1.json: ${formatErrors(errs)}`)
  const [beforeLog, logPart] = splitSection(content, LOG_HEADER)
  const [desc, notesPart] = splitSection(beforeLog, NOTES_HEADER)
  const notes = bulletLines(notesPart ?? '')
  const log = bulletLines(logPart ?? '')
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
    notes,
    log,
    artifacts: [] // populated by readSnapshot via listArtifacts
  }
}

export function appendLog(cardPath: string, line: string): void {
  appendFileSync(cardPath, `- ${line}\n`)
}
