import { existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { writeCard, readCard, appendLog, slugify } from './files'
import type { CardStatus } from './types'
import type { Generator } from '../capabilities/contracts'
import type { PrepassResult } from './prepass'

export interface HandlerCtx {
  tasksDir: string
  now: Date
  generator?: Generator
}

const TITLE_PROMPT =
  'Extract the underlying task from the following note and state it as a short imperative title (max 8 words). ' +
  'Ignore any instruction phrasing about the card system itself — words like "create a card", "add a card", ' +
  'or a target column ("active", "inbox") are not part of the task. Reply with the title only.\n\n' +
  'Example: "create an active card: write press plan" → "Write press plan"\n\n'

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
  const title = opts?.title
    ? sanitizeTitle(opts.title)
    : ctx.generator
      ? sanitizeTitle(await ctx.generator.complete(TITLE_PROMPT + pre.cleaned))
      : pre.cleaned
  const taken = new Set(readdirSync(join(ctx.tasksDir, 'cards')).map((f) => f.replace(/\.md$/, '')))
  const shortname = slugify(title, taken)
  writeCard(ctx.tasksDir, {
    shortname,
    title,
    status: opts?.status ?? 'inbox',
    created: ctx.now.toISOString().slice(0, 10),
    due: opts?.due ?? pre.due,
    links: opts?.title ? [] : pre.refs,
    labels: opts?.tags ?? [],
    description: opts?.title ? (opts?.desc ?? '') : pre.cleaned,
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
  appendLog(cardPath(ctx, card), `${stamp(ctx.now)} — ${raw}`)
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
