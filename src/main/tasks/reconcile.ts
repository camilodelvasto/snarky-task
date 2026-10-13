// Hand edits are first-class: the cards watcher diffs each change against the last
// state the engine knew and logs what changed, so a direct edit (hand or API) becomes
// an op in the card's log like any other. Engine-driven writes refresh the known state
// synchronously before the watcher fires, so they never double-log.

export interface CardFacts {
  status: string
  description: string
  title: string
}

export function diffCard(prev: CardFacts | undefined, next: CardFacts): string[] {
  if (!prev) return [] // new card — creation writes its own log line
  const changes: string[] = []
  if (prev.status !== next.status)
    changes.push(`status ${prev.status} → ${next.status} (direct edit)`)
  if (prev.title !== next.title) changes.push('title edited (direct edit)')
  if (prev.description !== next.description) changes.push('description edited (direct edit)')
  return changes
}
