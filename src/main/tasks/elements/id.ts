const CHARS = '0123456789abcdefghijklmnopqrstuvwxyz'

/** Returns a random base36 character [0-9a-z]. */
function randomBase36Char(): string {
  return CHARS[Math.floor(Math.random() * 36)]
}

/** djb2 hash — deterministic, no external deps. */
function djb2(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i)
    h = h >>> 0 // keep unsigned 32-bit
  }
  return h
}

/**
 * A deterministic id derived from content: `prefix` + 7-char base36 of a djb2 hash.
 * The SAME content always yields the SAME id — so an element migrated/materialized
 * from an unrewritten source (a v1 note, an output file) keeps its id across reads,
 * and an op targeting it by id still matches. On the rare hash collision within one
 * card, a deterministic `-N` suffix disambiguates by order.
 */
export function contentId(prefix: string, content: string, taken: Set<string> = new Set()): string {
  const base = prefix + djb2(content).toString(36).slice(0, 7)
  if (!taken.has(base)) return base
  let n = 1
  let id = `${base}-${n}`
  while (taken.has(id)) id = `${base}-${++n}`
  return id
}

/**
 * Mint a unique id of the form `prefix` + 4 base36 chars.
 * Loops until the generated id is not in `taken`.
 * @param prefix - the id prefix
 * @param taken - set of already-used ids to avoid
 * @param rand - optional injectable random source; returns one base36 char; defaults to randomBase36Char
 */
export function mintId(
  prefix: string,
  taken: Set<string>,
  rand: (() => string) | undefined = undefined
): string {
  const charSource = rand ?? randomBase36Char
  while (true) {
    const suffix =
      charSource() +
      charSource() +
      charSource() +
      charSource()
    const id = prefix + suffix
    if (!taken.has(id)) return id
  }
}
