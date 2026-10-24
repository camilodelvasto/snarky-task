import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Element, ElementShape } from './types'
import { contentId } from './id'

/** Artifact filenames lead with `YYYY-MM-DDTHH-MM` (createArtifact / writeArtifact
 *  both stamp them from toISOString). Surface that as a readable `YYYY-MM-DD HH:MM`.
 *  A name that isn't a timestamp (hand-named file) shows as itself, minus `.md`. */
function tsFromName(file: string): string {
  const m = file.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/)
  if (m) return `${m[1]} ${m[2]}:${m[3]}`
  return file.replace(/\.md$/, '')
}

/** A one-line glance at what the output is: the first line that carries words,
 *  with a leading markdown marker (#, -, *, >, digits.) stripped. Trimmed to a
 *  single line; the full text is loaded on demand when the row is opened. */
function previewOf(content: string): string {
  for (const raw of content.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    const stripped = line.replace(/^(#{1,6}|[-*>]|\d+\.)\s+/, '').trim()
    if (stripped) return stripped
  }
  return ''
}

export const outputShape: ElementShape = {
  type: 'output',
  schema: 'output.v1.json',
  storage: 'fs',
  ops: ['add', 'edit', 'drop'],

  materialize(tasksDir: string, shortname: string): Element[] {
    const dir = join(tasksDir, 'artifacts', shortname)
    if (!existsSync(dir)) return []

    const entries = readdirSync(dir, { withFileTypes: true })
    return entries
      .filter(entry => entry.isFile())
      .map(entry => {
        const file = entry.name
        const content = readFileSync(join(dir, file), 'utf-8')
        return {
          id: contentId('o', file),
          type: 'output',
          data: { file, ts: tsFromName(file), preview: previewOf(content) },
        }
      })
  },
}
