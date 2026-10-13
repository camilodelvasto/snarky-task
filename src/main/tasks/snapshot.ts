import { readdirSync, existsSync } from 'fs'
import { join } from 'path'
import { readInstruction, readCard } from './files'
import type { Snapshot, Instruction, Card } from './types'

function collect<T>(dir: string, read: (p: string) => T): T[] {
  const out: T[] = []
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
  return { instructions, cards }
}
