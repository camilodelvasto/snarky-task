import matter from 'gray-matter'
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync } from 'fs'
import { join, basename, dirname } from 'path'
import { randomBytes } from 'crypto'
import type { Card, Instruction } from './types'
import type { Element } from './elements/types'
import { validateCard, validateInstruction, formatErrors } from './validate'
import { BUNDLED } from './elements/registry'
import { bodyToElements, elementsToBody } from './elements/serialize'
import { mintId } from './elements/id'
import { migrateV1 } from './elements/migrate'

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

/**
 * writeCard input type: accepts full Card (with elements/id) or legacy callers
 * that only provide description/notes/log. The reconcile step in writeCard
 * merges legacy fields into elements so all existing handlers work unchanged.
 *
 * notes/elements/id are all optional: legacy callers omit them and the reconcile
 * builds elements purely from description/notes/log; callers that carry elements
 * (spread from readCard) can pass them through.
 */
export type WriteCardInput = Omit<Card, 'path' | 'artifacts' | 'elements' | 'id' | 'notes'> & {
  notes?: string[]
  /** If provided, used as source of truth; legacy description/notes/log are reconciled in. */
  elements?: Element[]
  /** If provided, written to frontmatter; otherwise a new id is minted. */
  id?: string
}

export function writeCard(tasksDir: string, card: WriteCardInput): string {
  const path = join(tasksDir, 'cards', `${card.shortname}.md`)

  // Mint a stable id if not already present.
  const cardId = card.id || mintId('c', new Set<string>())

  // ── Reconcile legacy fields into elements ─────────────────────────────────
  // Elements are the source of truth. When handlers spread `{...existing, log: [...old.log, line]}`
  // the existing elements already represent old.log; only the new line is appended.
  // When callers pass only legacy fields (no card.elements), we build elements from scratch.
  const workingElements: Element[] = card.elements ? [...card.elements] : []
  const takenIds = new Set<string>(workingElements.map((e) => e.id))

  // description → text (lead) element
  // Elements are authoritative: ONLY create a lead text element when none exists AND
  // the legacy description is non-empty. Never overwrite an existing text element —
  // callers that want to update the lead use applyOp('text','edit',…) directly.
  const existingTextEl = workingElements.find((e) => e.type === 'text')
  if (!existingTextEl && card.description !== '') {
    const id = 'lead'
    takenIds.add(id)
    workingElements.unshift({ id, type: 'text', data: { text: card.description } })
  }

  // notes → note elements
  // Legacy `notes` path removed: no current caller passes a legacy notes array.
  // handleNote uses applyOp; handleCreate never sets notes. Note elements come
  // solely from card.elements — the dedup-by-text path that silently collapsed
  // identical note texts is gone with this removal.

  // log → log elements
  // Log element id IS the content line (content-identity). For each log line not already
  // present as a log element (checked by id === line), append a new log element.
  const existingLogIds = new Set<string>(
    workingElements.filter((e) => e.type === 'log').map((e) => e.id)
  )
  for (const logLine of card.log) {
    if (!existingLogIds.has(logLine)) {
      existingLogIds.add(logLine)
      workingElements.push({ id: logLine, type: 'log', data: { line: logLine } })
    }
  }

  // ── Build frontmatter and body ─────────────────────────────────────────────
  // Only body-storage elements are serialized (fs elements like output are read-only).
  const bodyElements = workingElements.filter((e) => {
    const shape = BUNDLED[e.type]
    return shape && shape.storage === 'body'
  })

  const front: Record<string, unknown> = {
    v: 2,
    id: cardId,
    title: card.title,
    status: card.status,
    created: card.created,
    ...(card.due ? { due: card.due } : {}),
    links: card.links,
    labels: card.labels
  }
  const errs = validateCard(front)
  if (errs.length) throw new Error(`card "${card.shortname}" invalid: ${formatErrors(errs)}`)

  // elementsToBody always emits `## Log` last (even with zero log elements),
  // so appendLog always lands inside it.
  const body = '\n' + elementsToBody(bodyElements, BUNDLED) + '\n'
  writeFileAtomic(path, matter.stringify(body, front))
  return path
}

export function readCard(path: string): Card {
  const { data, content } = matter(readFileSync(path, 'utf-8'))

  const shortname = basename(path, '.md')
  // tasksDir = dirname of 'cards/' = dirname(dirname(path))
  const tasksDir = dirname(dirname(path))

  const rawVersion = (data as { v?: number })?.v ?? 1

  // ── v1 lazy migration (in-memory only — file is NOT rewritten) ────────────
  if (rawVersion === 1) {
    // Normalize the frontmatter for v1 validation: gray-matter parses bare date
    // strings (e.g. `created: 2026-10-01`) as Date objects. Coerce them back to
    // strings so the v1 JSON Schema (which requires `"type": "string"`) passes.
    const normalizedData: Record<string, unknown> = { ...data }
    if (normalizedData.created instanceof Date) {
      normalizedData.created = (normalizedData.created as Date).toISOString().slice(0, 10)
    }
    if (normalizedData.due instanceof Date) {
      normalizedData.due = (normalizedData.due as Date).toISOString().slice(0, 10)
    }
    const v1Errs = validateCard(normalizedData)
    if (v1Errs.length) {
      throw new Error(`${path} invalid against card.v1.json: ${formatErrors(v1Errs)}`)
    }
    const { front, elements: bodyElements } = migrateV1(data as Record<string, unknown>, content, BUNDLED)

    // Append fs-storage elements (e.g. output/artifacts) via their materialize() hooks
    const fsElements: Element[] = []
    for (const [, shape] of Object.entries(BUNDLED)) {
      if (shape.storage === 'fs' && shape.materialize) {
        fsElements.push(...shape.materialize(tasksDir, shortname))
      }
    }

    const elements: Element[] = [...bodyElements, ...fsElements]

    const textEl = elements.find((e) => e.type === 'text')
    const description = textEl ? (textEl.data.text as string).trim() : ''
    const notes = elements.filter((e) => e.type === 'note').map((e) => e.data.text as string)
    const log = elements.filter((e) => e.type === 'log').map((e) => e.data.line as string)
    const artifacts = elements.filter((e) => e.type === 'output').map((e) => e.data.file as string)

    return {
      shortname,
      path,
      id: front.id as string,
      title: front.title as string,
      status: front.status as import('./types').CardStatus,
      created: front.created as string,
      due: front.due ? String(front.due) : undefined,
      links: (front.links as string[]) ?? [],
      labels: (front.labels as string[]) ?? [],
      elements,
      description,
      notes,
      log,
      artifacts
    }
  }

  // ── v2 path (existing behavior) ───────────────────────────────────────────
  const errs = validateCard(data)
  if (errs.length) {
    throw new Error(`${path} invalid against card.v${rawVersion}.json: ${formatErrors(errs)}`)
  }

  // Parse body into elements using BUNDLED shapes (serialization must not depend on elements.json)
  const bodyElements = bodyToElements(content, BUNDLED)

  // Append fs-storage elements (e.g. output/artifacts) via their materialize() hooks
  const fsElements: Element[] = []
  for (const [, shape] of Object.entries(BUNDLED)) {
    if (shape.storage === 'fs' && shape.materialize) {
      fsElements.push(...shape.materialize(tasksDir, shortname))
    }
  }

  const elements: Element[] = [...bodyElements, ...fsElements]

  // ── Derive legacy fields from elements ────────────────────────────────────
  // description = lead text element's data.text, trimmed, or ''
  // trimEnd() in textShape.parse may leave a leading newline from the body layout;
  // trim() here ensures the derived field is clean (matches original readCard behaviour).
  const textEl = elements.find((e) => e.type === 'text')
  const description = textEl ? (textEl.data.text as string).trim() : ''

  // notes = note elements' data.text (in order)
  const notes = elements.filter((e) => e.type === 'note').map((e) => e.data.text as string)

  // log = log elements' data.line (in order)
  const log = elements.filter((e) => e.type === 'log').map((e) => e.data.line as string)

  // artifacts = output elements' data.file (in order)
  const artifacts = elements.filter((e) => e.type === 'output').map((e) => e.data.file as string)

  // card id: from frontmatter (v:2) or fall back to shortname for legacy v:1 cards
  const cardId: string = (data as { id?: string }).id ?? shortname

  return {
    shortname,
    path,
    id: cardId,
    title: data.title as string,
    status: data.status as import('./types').CardStatus,
    created: String(data.created),
    due: data.due ? String(data.due) : undefined,
    links: (data.links as string[]) ?? [],
    labels: (data.labels as string[]) ?? [],
    elements,
    description,
    notes,
    log,
    artifacts
  }
}

/**
 * Cheap EOF append of a single log line. The `## Log` section is always the
 * last block in every v:2 card body (guaranteed by elementsToBody), so this
 * blind append always lands inside it. On re-read, bodyToElements parses it as
 * a log element whose id equals the line content (content-identity, stable
 * across devices — diffCard dedup relies on this).
 */
export function appendLog(cardPath: string, line: string): void {
  appendFileSync(cardPath, `- ${line}\n`)
}
