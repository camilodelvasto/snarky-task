import { readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { readInstruction, readCard } from './files'
import { BUNDLED } from './elements/registry'
import type { Snapshot, Instruction, Card } from './types'

/** Per-type config the surfaces render and act from — derived from the bundled
 *  shapes (code), so it needs no elements.json and matches what read/writeCard use. */
function elementTypes(): NonNullable<Snapshot['elementTypes']> {
  return Object.fromEntries(
    Object.entries(BUNDLED).map(([type, shape]) => [
      type,
      { section: shape.section, lead: shape.lead, system: shape.system, ops: shape.ops }
    ])
  )
}

function collect<T>(dir: string, read: (p: string) => T): T[] {
  const out: T[] = []
  // A synced workspace may be missing an empty subdir (Syncthing drops empties);
  // a read must never crash the snapshot/broadcast — treat absent as empty.
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.md'))
    .sort()) {
    try {
      out.push(read(join(dir, name)))
    } catch (err) {
      console.error(`snapshot: skipping unparseable ${name}:`, err)
    }
  }
  return out
}

function listArtifacts(tasksDir: string, shortname: string): string[] {
  const dir = join(tasksDir, 'artifacts', shortname)
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir)
      .filter((n) => !n.startsWith('.'))
      .sort()
  } catch {
    return []
  }
}

export function readSnapshot(tasksDir: string): Snapshot {
  const instructions = collect<Instruction>(join(tasksDir, 'queue'), readInstruction)
  const cards = collect<Card>(join(tasksDir, 'cards'), readCard)
    .sort((a, b) => a.created.localeCompare(b.created) || a.shortname.localeCompare(b.shortname))
    .map((c) => ({ ...c, artifacts: listArtifacts(tasksDir, c.shortname) }))
  return { instructions, cards, elementTypes: elementTypes() }
}
