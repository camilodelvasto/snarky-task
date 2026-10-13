import type { Card } from './types'

const tokens = (s: string): Set<string> =>
  new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)
  )

export function selectCandidates(cleaned: string, cards: Card[], max = 8): Card[] {
  const t = tokens(cleaned)
  return cards
    .map((c) => {
      const ct = tokens(`${c.title} ${c.shortname.replace(/-/g, ' ')}`)
      let score = 0
      for (const tok of ct) if (t.has(tok)) score++
      return { c, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.c.created.localeCompare(a.c.created))
    .slice(0, max)
    .map((x) => x.c)
}
