import type { Card } from './types'
import type { Resolver } from '../capabilities/contracts'
import { selectCandidates } from './candidates'

/**
 * Narrow card pick: resolve a fuzzy card reference ("the munich thing") to a
 * shortname via one resolver question. Used by the engine when the CLI claims
 * a verb but can't bind the card (needs-card). The whole deck is the ballot —
 * the classifier is cheap at this scale.
 *
 * Deliberately NO explicit "none of these" option: measured against the real
 * checkpoint, the escape option absorbs 0.62–0.99 probability on terse queries
 * even when the model knows the card (balcony: 0.35 none-beaten vs 0.80 when
 * none is absent). "No match" is expressed by the margin instead — a nonsense
 * query spreads mass across candidates (margin ~0.52) and parks at the gate.
 *
 * Deliberately NO keyword prefilter on the ballot either: exact-token overlap
 * is brittle exactly when the model is needed. Measured: "the prototye
 * applciation card" (typos) scored 0 on the intended card — excluded from the
 * pool, Laya confidently picked a wrong card (0.93). Offered the whole deck it
 * picks the intended card at 0.9998 through both typos, ~650ms warm for 12
 * options. Keyword ranking survives only for the "did you mean" suggestions.
 */
export async function resolveCardRef(
  query: string,
  cards: Card[],
  resolver: Resolver,
  threshold: number
): Promise<{ card: string; confidence: number } | { error: string }> {
  if (cards.length === 0) return { error: 'could not resolve target card' }
  const c = await resolver.decide({
    context: query,
    question: 'Which card does this instruction refer to?',
    options: cards.map((card) => ({ key: card.shortname, description: card.title }))
  })
  if (c.confidence < threshold) {
    // Carry the near-misses — an incomplete-but-sufficient input should get
    // a suggestion it can act on, not a dead end.
    const closest = selectCandidates(query, cards)
      .slice(0, 2)
      .map((card) => `#${card.shortname}`)
      .join(' or ')
    return {
      error: closest
        ? `could not resolve target card — did you mean ${closest}?`
        : 'could not resolve target card'
    }
  }
  return { card: c.key, confidence: c.confidence }
}
