// src/main/tasks/context.ts
//
// Pure assembly of the text a delegation carries to a collaborator. The engine
// gathers the raw material (the card, its prior artifact bodies, the project's
// other cards); this module decides how much of it a given scope reveals:
//
//   card  — title + description + user notes + the instruction text (default)
//   full  — + the card's system activity log and its prior outputs
//   board — + a one-line roster of every other live card in the project
//
// Private cards never appear in the board roster (the delegate guard refuses a
// private card as the target; this is the second half of the same promise).
import type { Card, Scope } from './types'

export interface DelegationContextInput {
  card: Card
  scope: Scope
  text?: string // the instruction text accompanying the delegation
  artifactTexts?: string[] // bodies of the card's prior artifacts (full/board)
  board?: Card[] // the project's other cards, for the board roster
  privateLabel?: string // label that keeps a card out of the roster (default 'private')
}

const firstLine = (s: string): string => s.split('\n')[0].trim()

export function buildDelegationContext(input: DelegationContextInput): string {
  const { card, scope, text, artifactTexts = [], board = [], privateLabel = 'private' } = input

  const sections: string[] = [
    [card.title, card.description, text]
      .map((p) => p?.trim())
      .filter(Boolean)
      .join('\n\n')
  ]

  // User notes are card content — sent at every scope, including the default.
  // System events (status/label/delegation) stay in the log, full/board only.
  if (card.notes.length) sections.push('## Notes\n' + card.notes.join('\n'))

  if (scope === 'full' || scope === 'board') {
    if (card.log.length) sections.push('## Activity\n' + card.log.join('\n'))
    if (artifactTexts.length)
      sections.push('## Prior outputs\n' + artifactTexts.join('\n\n---\n\n'))
  }

  if (scope === 'board') {
    const roster = board
      .filter((c) => c.shortname !== card.shortname && !c.labels.includes(privateLabel))
      .map(
        (c) =>
          `- #${c.shortname} [${c.status}] ${c.title}` +
          (c.description ? ` — ${firstLine(c.description)}` : '')
      )
    if (roster.length) sections.push('## Other cards in this project\n' + roster.join('\n'))
  }

  return sections.join('\n\n')
}
