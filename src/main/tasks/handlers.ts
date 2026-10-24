import { existsSync, readdirSync, rmSync, renameSync } from 'fs'
import { join } from 'path'
import { writeCard, readCard, appendLog, slugify } from './files'
import type { CardStatus } from './types'
import type { PrepassResult } from './prepass'
import { applyOp } from './elements/ops'
import { BUNDLED } from './elements/registry'

export interface HandlerCtx {
  tasksDir: string
  now: Date
}

const stamp = (now: Date): string => now.toISOString().slice(0, 16).replace('T', ' ')

function cardPath(ctx: HandlerCtx, card: string): string {
  const p = join(ctx.tasksDir, 'cards', `${card}.md`)
  if (!existsSync(p)) throw new Error(`card not found: ${card}`)
  return p
}

/** Defense against a misbehaving generator (reasoning dumps, quote wrapping, essays):
 *  a title is one line, unquoted, and short — anything else is cut down or rejected. */
function sanitizeTitle(raw: string): string {
  const line =
    raw
      .split('\n')
      .map((l) =>
        l
          .trim()
          .replace(/^["'`]+|["'`]+$/g, '')
          .trim()
      )
      .find((l) => l.length > 0) ?? ''
  if (!line) throw new Error('generator returned no usable title')
  return line.length > 80 ? `${line.slice(0, 77)}…` : line
}

export async function handleCreate(
  ctx: HandlerCtx,
  pre: PrepassResult,
  opts?: { title?: string; desc?: string; tags?: string[]; due?: string; status?: CardStatus }
): Promise<string> {
  // Capture is deterministic — no model on this path, ever. The first line IS
  // the title (sigil tokens stripped, sanitized to one short line); continuation
  // lines are the description. A thought becomes a card instantly and offline.
  const taken = new Set(
    readdirSync(join(ctx.tasksDir, 'cards'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
  )
  const lines = pre.cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  const firstLine = (lines[0] ?? '')
    .replace(/#[a-z0-9-]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const title = sanitizeTitle(opts?.title ?? (firstLine || pre.cleaned))
  // #words that name existing cards are links; the rest were meant as labels.
  const refLinks = opts?.title ? [] : pre.refs.filter((r) => taken.has(r))
  const refLabels = opts?.title ? [] : pre.refs.filter((r) => !taken.has(r))
  const shortname = slugify(title, taken)
  writeCard(ctx.tasksDir, {
    shortname,
    title,
    status: opts?.status ?? 'inbox',
    created: ctx.now.toISOString().slice(0, 10),
    due: opts?.due ?? pre.due,
    links: refLinks,
    labels: opts?.tags ?? refLabels,
    description: opts?.title ? (opts?.desc ?? '') : lines.slice(1).join('\n'),
    log: [`${stamp(ctx.now)} — created`]
  })
  return shortname
}

export function handleUpdateStatus(
  ctx: HandlerCtx,
  card: string,
  status: CardStatus,
  raw: string
): string {
  const path = cardPath(ctx, card)
  const existing = readCard(path)
  writeCard(ctx.tasksDir, { ...existing, status })
  appendLog(path, `${stamp(ctx.now)} — status → ${status} ("${raw}")`)
  return `#${card} → ${status}`
}

export function handleNote(ctx: HandlerCtx, card: string, raw: string): string {
  // A note is card content, not a system event — it goes to the ## Notes section
  // (sent to delegates by default), not the ## Log. Read-modify-write so the two
  // sections stay cleanly separate; same-card ops are serialized by the engine.
  const path = cardPath(ctx, card)
  const existing = readCard(path)
  writeCard(ctx.tasksDir, {
    ...existing,
    elements: applyOp(existing.elements, 'note', 'add', { at: stamp(ctx.now), text: raw }, BUNDLED)
  })
  return `note on #${card}`
}

export function handleLink(ctx: HandlerCtx, a: string, b: string): string {
  for (const [x, y] of [
    [a, b],
    [b, a]
  ] as const) {
    const path = cardPath(ctx, x)
    const card = readCard(path)
    if (!card.links.includes(y)) writeCard(ctx.tasksDir, { ...card, links: [...card.links, y] })
  }
  return `#${a} ↔ #${b}`
}

export function handleLabel(ctx: HandlerCtx, card: string, tags: string[]): string {
  if (!tags.length) throw new Error('label needs #tags — e.g. `tag #card #tag`')
  const path = cardPath(ctx, card)
  const existing = readCard(path)
  const labels = [...new Set([...existing.labels, ...tags])]
  // A tag is a signal of attention: labeling a backlog card surfaces it.
  const status =
    existing.status === 'inbox' || existing.status === 'waiting' ? 'active' : existing.status
  writeCard(ctx.tasksDir, { ...existing, labels, status })
  appendLog(path, `${stamp(ctx.now)} — labels + ${tags.join(', ')}`)
  if (status !== existing.status) appendLog(path, `${stamp(ctx.now)} — status → active (labeled)`)
  return `#${card} +${tags.join(',')}`
}

export function handleUnlabel(ctx: HandlerCtx, card: string, tags: string[]): string {
  if (!tags.length) throw new Error('unlabel needs #tags — e.g. `untag #card #tag`')
  const path = cardPath(ctx, card)
  const existing = readCard(path)
  const labels = existing.labels.filter((l) => !tags.includes(l))
  writeCard(ctx.tasksDir, { ...existing, labels })
  appendLog(path, `${stamp(ctx.now)} — labels − ${tags.join(', ')}`)
  return `#${card} -${tags.join(',')}`
}

export function handleDelete(ctx: HandlerCtx, card: string): string {
  rmSync(cardPath(ctx, card))
  return `deleted #${card}`
}

/**
 * Rename a card, letting the slug/id follow the title — implemented as
 * copy-then-delete (per the simpler, safer path): write a new card under the
 * title-derived slug with all content preserved, move its artifacts folder,
 * repoint `#ref` links in other cards, then delete the old file. Returns the
 * new shortname (the engine records it as the instruction's card).
 *
 * If the new title slugifies to the same id, this is a cheap in-place title
 * update — no copy, no moved files, no broken references.
 */
export function handleRename(ctx: HandlerCtx, card: string, newTitle: string): string {
  const title = sanitizeTitle(newTitle)
  if (!title) throw new Error('rename needs a new title')
  const path = cardPath(ctx, card) // throws if the card is missing
  const old = readCard(path)

  const taken = new Set(
    readdirSync(join(ctx.tasksDir, 'cards'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
  )
  taken.delete(card) // the old slug is free to reuse if the title maps back to it
  const slug = slugify(title, taken)

  if (slug === card) {
    writeCard(ctx.tasksDir, { ...old, title })
    appendLog(path, `${stamp(ctx.now)} — renamed to "${title}"`)
    return card
  }

  // Copy to the new slug, preserving everything (notes/log/labels/status/due).
  writeCard(ctx.tasksDir, {
    ...old,
    shortname: slug,
    title,
    log: [...old.log, `${stamp(ctx.now)} — renamed from #${card}`]
  })
  // Move the artifacts folder so prior outputs follow the card.
  const oldArt = join(ctx.tasksDir, 'artifacts', card)
  if (existsSync(oldArt)) renameSync(oldArt, join(ctx.tasksDir, 'artifacts', slug))
  // Repoint `#ref` links in every other card (body-text refs are left as-is).
  const cardsDir = join(ctx.tasksDir, 'cards')
  for (const f of readdirSync(cardsDir).filter((n) => n.endsWith('.md'))) {
    if (f === `${card}.md`) continue
    const c = readCard(join(cardsDir, f))
    if (c.links.includes(card))
      writeCard(ctx.tasksDir, { ...c, links: c.links.map((l) => (l === card ? slug : l)) })
  }
  rmSync(path)
  return slug
}

/**
 * Set a card's description (body) directly from the console — the piece rename
 * (title) and note (log) don't cover. Replaces the description wholesale; notes,
 * labels, status and title are untouched. Logs that the body changed.
 */
export function handleDescribe(ctx: HandlerCtx, card: string, text: string): string {
  const path = cardPath(ctx, card) // throws if the card is missing
  const old = readCard(path)
  writeCard(ctx.tasksDir, {
    ...old,
    elements: applyOp(old.elements, 'text', 'edit', { text }, BUNDLED)
  })
  appendLog(path, `${stamp(ctx.now)} — description updated`)
  return card
}

/**
 * Change a card's slug directly to an explicit value — unlike rename, the title
 * is left untouched (the slug is the thing being set, not a side effect of a new
 * title). Same copy-then-delete motion as rename: write under the new slug with
 * everything preserved, move artifacts, repoint structured `#ref` links, delete
 * the old file. Refuses to clobber an existing slug and validates the new one so
 * a bad target parks loud instead of corrupting the deck. Returns the new slug.
 */
export function handleReslug(ctx: HandlerCtx, card: string, newSlug: string): string {
  const slug = newSlug.trim().toLowerCase()
  if (!slug) throw new Error('reslug needs a new slug')
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`"${slug}" is not a valid slug ([a-z0-9-])`)
  const path = cardPath(ctx, card) // throws if the card is missing
  if (slug === card) throw new Error(`#${card} already has that slug`)
  if (existsSync(join(ctx.tasksDir, 'cards', `${slug}.md`)))
    throw new Error(`cannot reslug to #${slug} — a card already uses that slug`)
  const old = readCard(path)

  // Copy to the new slug, preserving everything including the title.
  writeCard(ctx.tasksDir, {
    ...old,
    shortname: slug,
    log: [...old.log, `${stamp(ctx.now)} — reslugged from #${card}`]
  })
  // Move the artifacts folder so prior outputs follow the card.
  const oldArt = join(ctx.tasksDir, 'artifacts', card)
  if (existsSync(oldArt)) renameSync(oldArt, join(ctx.tasksDir, 'artifacts', slug))
  // Repoint `#ref` links in every other card (body-text refs are left as-is).
  const cardsDir = join(ctx.tasksDir, 'cards')
  for (const f of readdirSync(cardsDir).filter((n) => n.endsWith('.md'))) {
    if (f === `${card}.md`) continue
    const c = readCard(join(cardsDir, f))
    if (c.links.includes(card))
      writeCard(ctx.tasksDir, { ...c, links: c.links.map((l) => (l === card ? slug : l)) })
  }
  rmSync(path)
  return slug
}
