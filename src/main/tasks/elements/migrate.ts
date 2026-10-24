import type { Element } from './types'
import type { ShapeMap } from './types'
import { mintId, contentId } from './id'

/**
 * Parse a v1 card body into a lead text element + note elements + log elements.
 *
 * v1 body layout:
 *   <description paragraph before the first "## ">
 *   ## Notes
 *   - <ts> — <text>
 *   ...
 *   ## Log
 *   - <ts> — <text>
 *   ...
 *
 * The stamp format is `YYYY-MM-DD HH:MM` — it becomes `data.at` on note elements.
 * Log elements use content-identity (id = line content, matching logShape.parse).
 */
export function migrateV1(
  frontmatter: Record<string, unknown>,
  body: string,
  _shapes: ShapeMap
): { front: Record<string, unknown>; elements: Element[] } {
  const elements: Element[] = []
  const takenIds = new Set<string>()

  // ── Split body into sections ──────────────────────────────────────────────
  // Split at lines that start with "## " (section headings).
  const parts = body.split(/^(?=## )/m)

  // The first part is everything before the first "## " heading (description)
  let leadText = parts[0].trim()

  // Find the ## Notes and ## Log sections
  let notesLines: string[] = []
  let logLines: string[] = []

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]
    const firstNewline = part.indexOf('\n')
    const heading = firstNewline === -1 ? part : part.slice(0, firstNewline)
    const sectionBody = firstNewline === -1 ? '' : part.slice(firstNewline + 1)
    const headingTrimmed = heading.trim()

    const bulletLines = sectionBody
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))

    if (headingTrimmed === '## Notes') {
      notesLines = bulletLines
    } else if (headingTrimmed === '## Log') {
      logLines = bulletLines
    }
  }

  // ── Lead text element ─────────────────────────────────────────────────────
  if (leadText !== '') {
    const id = 'lead'
    takenIds.add(id)
    elements.push({ id, type: 'text', data: { text: leadText } })
  }

  // ── Note elements ─────────────────────────────────────────────────────────
  // Format: `- <ts> — <text>`
  // ts = YYYY-MM-DD HH:MM  →  data.at = ts (full timestamp string)
  for (const line of notesLines) {
    // Strip leading "- "
    const content = line.slice(2)
    const sepIdx = content.indexOf(' — ')
    if (sepIdx === -1) {
      // Malformed line — skip
      continue
    }
    const at = content.slice(0, sepIdx).trim()
    const text = content.slice(sepIdx + 3).trim()
    // Content-derived, NOT random: the file isn't rewritten, so every read
    // re-migrates — a random id would change each read and break scratch/edit/drop
    // (the UI's id would no longer exist on the engine's re-read).
    const id = contentId('n', `${at}\n${text}`, takenIds)
    takenIds.add(id)
    elements.push({ id, type: 'note', data: { at, text } })
  }

  // ── Log elements ──────────────────────────────────────────────────────────
  // Format: `- <line>`
  // id = line content (content-identity, stable across devices)
  for (const line of logLines) {
    // Strip leading "- "
    const content = line.slice(2)
    // content is the full log line; id = content
    elements.push({ id: content, type: 'log', data: { line: content } })
  }

  // ── Upgrade frontmatter ───────────────────────────────────────────────────
  // Normalize created/due to string (gray-matter may parse date values as Date objects)
  const createdRaw = frontmatter.created
  const created =
    createdRaw instanceof Date
      ? createdRaw.toISOString().slice(0, 10)
      : String(createdRaw ?? '')

  const dueRaw = frontmatter.due
  const due =
    dueRaw instanceof Date
      ? dueRaw.toISOString().slice(0, 10)
      : dueRaw !== undefined && dueRaw !== null
        ? String(dueRaw)
        : undefined

  // Mint an id if the v1 card doesn't have one
  const existingId = frontmatter.id as string | undefined
  const cardId = existingId && existingId.length > 0 ? existingId : mintId('c', takenIds)

  const front: Record<string, unknown> = {
    v: 2,
    id: cardId,
    title: frontmatter.title,
    status: frontmatter.status,
    created,
    ...(due !== undefined ? { due } : {}),
    links: (frontmatter.links as string[]) ?? [],
    labels: (frontmatter.labels as string[]) ?? []
  }

  return { front, elements }
}
