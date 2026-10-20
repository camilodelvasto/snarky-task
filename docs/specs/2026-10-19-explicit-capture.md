# Explicit capture — amends "absence of command means create"

**Date:** 2026-10-19
**Status:** approved in conversation
**Amends:** `docs/specs/2026-10-06-slot-resolution-design.md` (principle 2, "absence of command means create")

## Why

The slot-resolution redesign gave bare non-command text exactly one fate: it became a card
("absence of command means create"). In practice that was too eager. Because the broad
resolver was removed, the input box could no longer distinguish three things that all look
identical — a deliberate thought, a mistyped command, and a natural-language command:

- `promtoe #card` (typo of promote) → a card titled "promtoe #card", silently.
- `remove hetzner payment card` (clear intent) → a card, never evaluated as a command.
- `buy milk` (a real thought) → a card, as intended.

The first two are mistakes the console silently filed. The cost of frictionless capture was
that the box forgave nothing and filed everything.

## Decision

**Capture is explicit; non-command input parks.**

- A line whose first token is a recognized command (verb/alias, `project`, leading
  `@collaborator`, or `/`-forced) runs as before.
- A line beginning with `+` is an **explicit capture**: the remainder is filed as a card,
  routed through the same grammar as `create` (`#tag` → label, `$date` → due, free text →
  title, continuation lines → description). `+ call the plumber #urgent` → a card. A bare
  `+` with no text errors (no blank card).
- **Anything else declines and parks in `attention`** with `unknown command "<token>" —
  start the line with + to capture a card`. It is never silently filed. The parked row is
  visible and editable, so a typo is caught instead of buried.

This keeps capture one keystroke cheap while making it deliberate, so typos, pasted text,
and natural-language commands no longer become cards by accident.

## Notes

- The `+` marker is a single check in `parseCommand` and trivially swappable; `+` reads as
  "add this".
- This does NOT reintroduce the broad resolver. A natural-language command like `remove X`
  parks (honest "I don't know this command") rather than being guessed at. If a word like
  `remove` should mean delete, add it as a registry alias — one line of data — so it flows
  through the CLI + card-pick deterministically.
- Tests: `cli.test.ts` (`+` capture grammar; plain language still declines), `engine.test.ts`
  (bare input parks, `+` captures, a question parks not mutates).
