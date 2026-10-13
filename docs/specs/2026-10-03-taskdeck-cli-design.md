# taskdeck CLI layer — design

**Date:** 2026-10-03
**Status:** approved in discussion; this document is the written spec
**Builds on:** `docs/specs/2026-10-02-taskdeck-design.md` (pre-resolved instructions, registry, capabilities)

## Purpose

The feed input should behave like a CLI for users who know the commands, while staying a
natural-language box for everyone else. A typed command bypasses the resolver entirely —
deterministic, instant, no model. Language still flows to the resolver. Heavy executors
(collaborators) engage only when explicitly summoned.

This is a **layered chain, not a fallback**: each layer is deterministic about whether it
*claims* an input, every handoff is visible in the UI, and a forced command (`/`) never
falls through. Layers run from most deterministic/cheapest to least/heaviest:

| layer | engine | latency | claims input when |
|---|---|---|---|
| 1 | CLI parser (pure function + card index) | ~0 ms | first token is a known verb/alias AND the full grammar parses |
| 1.5 | narrow card pick (resolver, card-gated) | ~100 ms warm | layer 1 claimed the verb + args but the card reference stayed fuzzy (bare input only) |
| 2 | resolver (Laya, margin-gated) | ~100 ms warm | layer 1 declined (and input is not `/`-forced) |
| 3 | collaborator executors (claude-cli, ollama) | seconds–minutes | a parsed command carries `--with`, or resolver chose `delegate` |

**Superseded (2026-10-06):** layers 1.5–2 as described here are replaced by the slot-resolution model — see `docs/specs/2026-10-06-slot-resolution-design.md`. The grammar, sigils, aliases, and `/` semantics in this document remain authoritative.

**Partial decline (layer 1.5).** When a card-taking verb parses but deterministic card
matching (exact slug, unique prefix) finds nothing — `promote the munich thing` — the CLI
emits `needs-card` instead of declining whole. Every decision already made (action,
status, tags, due) stays decided; the resolver answers only "which card does *the munich
thing* mean?" over the whole deck. Two deliberate absences, both measured on the real
checkpoint: no "none of these" option (the escape absorbs 0.62–0.99 probability on terse
queries even when the model knows the card — "no match" is the margin gate's job: nonsense
spreads mass, margin ~0.52, park) and no keyword prefilter on the ballot (exact-token
overlap excluded the intended card on a typo'd query, producing a confident wrong pick at
0.93; the whole deck resolves the same query at 0.9998 through the typos). Keyword ranking
survives only for "did you mean" suggestions.
A confident pick executes as `via: cli+ai` (feed marker `›_✦`, engine
`cli+<impl>`); a miss parks with near-miss suggestions — the action can never be misread.
`/`-forced input never reaches 1.5: `/` promises no model and fails loud.

## Canonical command set (layer 1)

The canonical form is directly typeable; sugar (below) desugars into it.

```
create   --title <text> [--desc <text>] [--tag a,b] [--due <date>] [--status <s>] [--with <collab>]
move     --card <ref> --status <s>
note     --card <ref> --text <text>
link     --card <ref> --card2 <ref>
delete   --card <ref>
delegate --card <ref> --with <collab> [--text <text>]
```

### Aliases

First-token synonyms, stored in `registry.json` beside the actions so they are editable
data, not code:

```json
"aliases": {
  "create": ["add", "new"],
  "move": ["mv"],
  "note": ["log"],
  "delete": ["del", "rm"]
}
```

`update_status` keeps its registry key; `move` is its CLI verb.

## Trigger rules

- **Bare verb** (`create apply to fund $active`): parsed as a command iff the first token
  is a verb/alias AND the entire input parses under that verb's grammar. ~~Any parse
  failure → the input is NOT claimed; it flows to layer 2 as plain language.~~
  (superseded 2026-10-06: the fork is final — once a verb is bound, any grammar failure
  parks the instruction in `attention` with the parse error. Only a non-verb first token
  causes a decline, and declined input is captured as a card via the create default.)
- **Slash-forced** (`/create …`, `/mvoe …`): layer 1 claims it unconditionally. Parse
  failure → instruction parks in `attention` with the parse error (`unknown command
  "mvoe"`, `note needs a #card`). Never falls through.
- The `/` prefix also drives the feed's command autocomplete menu (verbs, then
  contextual completions: `#` shortnames, `$` statuses, `@` collaborators).

## Sugar grammar

Tokens anywhere after the verb; order-free. Everything not consumed by a sigil is free text.

| token | meaning | rule |
|---|---|---|
| `$word` | status or due date | status-enum member → `--status`; else chrono-parsed date (`$today`, `$friday`, `$oct-20`) → `--due`; neither → parse failure |
| `@name` | collaborator | must match a configured collaborator → `--with`; unknown → parse failure |
| `#word` | ref or tag | on `create`: always `--tag`. On card-targeting verbs: a `#` matching an existing card shortname (deterministic file lookup, no model) binds `--card` (first match; second match on `link` binds `--card2`); non-matching `#`s are `--tag`s |
| free text | `--title` (create) / `--text` (note, delegate) | whatever remains on the first line |
| newline + rest | `--desc` | the prompt is a textarea (Shift+Enter); lines after the first are the description/context verbatim |

Worked example:

```
create submit proposal prototype #urgent $today $active @claude #offline
→ create --title "submit proposal prototype" --tag urgent,offline
         --due 2026-10-03 --status active --with claude
```

`createx submit proposal …` → first token is not a verb/alias → layer 1 declines →
~~resolver treats the whole line as language~~ (superseded 2026-10-06: unclaimed input
is captured as a card via the create default — the resolver is not consulted).

## Execution semantics

A parsed command becomes a **pre-resolved instruction** — the same door as everything
else (`POST /api/instructions`, file in `queue/`), with its resolution in frontmatter.
The engine skips split + resolve for it and keeps every downstream gate (freeze,
destructive confirmation, handlers). Frontmatter grows to carry the full parse:

```yaml
---
status: queued
action: create            # registry key (move → update_status)
to: active                # --status
title: submit proposal prototype
desc: |                   # --desc (if any)
  …
tags: [urgent, offline]   # --tag
due: '2026-10-03'         # --due
with: claude              # --with
---
create submit proposal prototype #urgent $today $active @claude #offline
```

(The raw line is preserved as the body — the file remains the audit trail.)

- **create**: `--title` is used verbatim — **no generator call** on the CLI path. `--desc`
  becomes the description (default: empty). `--status` places the card directly
  (default `inbox`). `--tag` → labels, `--due` → due.
- **move / note / link / delete**: map to existing handlers; `delete` still parks at
  `needs_confirmation` (destructive class is a property of the action, not the layer).
- **`--with <collab>`** on create/delegate: after the card write, queue a delegation job
  (existing JobPool) whose prompt is the card's title + description. Output lands in
  `artifacts/<card>/`, with a log line on the card. Heavy executors run only here.
  When `delegate` carries free text (e.g. `delegate #card @claude do a cost analysis`),
  that text is appended to the prompt after title and description.

## Collaborators (`workspace/tasks/config.json`)

Named handles over existing capabilities — a binding, not a new capability type:

```json
"collaborators": {
  "claude": { "use": "agent" },
  "local":  { "use": "generator" }
}
```

`@claude` → the bound `agent` (claude-cli), `@local` → the bound `generator` (ollama).
Unknown `use` values throw at startup (no-fallbacks). ~~The resolver-driven `delegate`
path keeps its executor question for language input; `@name` makes it deterministic.~~
(superseded 2026-10-06: delegate always requires a named collaborator — either `@name`
or a bare collaborator word; the executor question was deleted.)

## UI

- Feed rows show which layer claimed the instruction: a small `›_` marker for CLI,
  `✦` for resolver. A bare command that fell through to the resolver is therefore
  always visible at a glance.
- `/` opens the command autocomplete (verbs + aliases with one-line usage); `#`, `$`,
  `@` complete shortnames, statuses, and collaborators contextually (extending the
  existing `#` completion).
- Parse errors on `/`-forced commands render in the row's error slot like any
  `attention`, with the exact parse message.

## Error handling

- ~~Bare parse failure → not an error; input flows to layer 2 (visible via layer marker).~~
  (superseded 2026-10-06: bare parse failure after a verb is bound parks in `attention`
  with the parse error; only a non-verb first token declines, and declined input is
  captured as a card.)
- `/`-forced parse failure → `attention` with the parse error. Edit-and-requeue works
  as it does today.
- Unknown collaborator, bad `$token`, missing required ref → parse failures (above).
- A `--with` job failure → `attention` on the instruction with the executor's real
  error (existing delegate semantics).

## Non-goals (v1)

- No sigils inside plain-language instructions (layer 2 input is passed through
  untouched; `#refs` keep their existing prepass meaning).
- No new executors — collaborators name existing bound capabilities only.
- No flag-style input in the feed beyond the canonical long form already parsing
  (power users may type it; it is not documented UI).
- No per-collaborator capability scoping beyond the `use` binding (future work:
  collaborator-specific prompts/tools).

## Testing

- **Parser unit tests** (pure function): every verb, every sigil rule, alias mapping,
  `#` ref-vs-tag against a fake card index, `$` status-vs-date-vs-failure, unknown
  `@`, bare-decline vs slash-force, multiline desc, worked example verbatim.
- **Engine tests**: parsed-command frontmatter executes without resolver (extends the
  existing pre-resolved tests); create-with-title skips generator; `--with` queues a
  delegation; `/`-forced failure parks in `attention`.
- **Server test**: POST accepts the extended pre-resolved fields.
- Existing suites must stay green; resolver path behavior is unchanged.
