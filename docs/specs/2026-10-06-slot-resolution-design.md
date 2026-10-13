# Slot resolution — re-founding the taskdeck pipeline

**Date:** 2026-10-06
**Status:** approved in conversation; supersedes the layered-chain resolution model of
`2026-10-03-taskdeck-cli-design.md` (the CLI grammar itself is unchanged and still
authoritative there)
**Replaces:** broad AI resolution (action classification, status classification,
instruction splitting, resolver-picked executors)

## Why

Four production misfires in three days, one disease:

| symptom | patch we shipped |
|---|---|
| "none of these cards" absorbed answers the model knew | deleted the escape option |
| keyword prefilter excluded the right card from the ballot | deleted the prefilter |
| `promote the munich thing` declined whole despite a certain verb | built needs-card |
| `@local what is a screencast?` — a 3/4-parsed delegate declined whole; the fallback re-derived all four slots and moved an unrelated card | this spec |

**The unit of claiming was the instruction, but the unit of certainty is the slot.** An
instruction is a small sentence filling slots — action, target card, status, text,
executor, dates, tags. The old chain resolved whole-instructions-per-layer, so any input
with three certain slots and one open slot had to be either rejected or entirely
re-derived by a probabilistic layer. Every patch above was a hand-carved special case of
the actual principle. This spec states the principle once and deletes the patches' reason
to exist.

## Principles

1. **Layers bind slots, not instructions.** Information bound deterministically is never
   re-derived. Binding instruments, cheapest first: grammar (sigils, flags, verbs) →
   convention (leading `@`, bare-ref slug/prefix, verb sugar) → narrow model question →
   declared default → park.
2. **Absence of command means create.** If the first token is not a verb/alias, a leading
   `@collaborator`, or `/`, the input is language and language is *captured* — a card.
   Nobody — and no model — ever picks the action.
3. **The model only disambiguates references.** Laya answers exactly one kind of
   question: "which card does this fragment mean?" — whole deck on the ballot, margin
   confidence, `thresholds.card` gate. No action question, no status question, no
   executor question. (Measured basis: 0.97 on "the door thing", 0.9998 through two
   typos; the escape option and the keyword prefilter both made it *worse* — see the
   layer-1.5 section of the CLI spec.)
4. **Mutations are verb-only.** Changing existing state (move, label, delete) always
   traces to explicit grammar. Capture (create, note-with-ref, delegate) is the universal
   default for everything else. "The munich thing is done" without a verb becomes a card,
   not a status change — predictability over cleverness; vocabulary grows as registry
   alias *data*, never as resolution rules.

## The fork

```
input
 ├─ first token is verb/alias, leading @collab, or /  →  COMMAND path
 └─ anything else                                     →  CREATE (capture) path
```

**The fork is final.** A recognized command that fails its grammar parks in `attention`
with the parse error — bare or `/`-forced alike. It never "falls back" to being language;
that silent reinterpretation was the root of the misfires. Consequence: to capture text
that *begins* with a verb word (a card literally titled "move fast"), write
`create move fast`. Document this in the feed's parse errors.

- **Command path:** parse per the CLI grammar (unchanged). Conventions still apply:
  leading `@x` ⇒ `delegate --with x`; verb sugar (`promote` ⇒ `move $active`); bare-ref
  exact-slug and unique-prefix matching. After parsing, any still-open slot resolves per
  the action's declared policy (below).
- **Create path:** existing `handleCreate` semantics, unchanged — first line title (via
  generator cleanup where configured), rest description, chrono due extraction, `#refs`
  become links, `#words` become tags.

## Per-action target policy (registry data, not code)

Each registry action declares what an **open target slot** means — equivalently, what
free text means when no `#ref` bound the card:

```json
{
  "create":        { "class": "normal",      "target": "none" },
  "update_status": { "class": "normal",      "target": "resolve", "params": { "status": ["inbox", "active", "waiting", "done", "dropped"] } },
  "label":         { "class": "normal",      "target": "resolve" },
  "unlabel":       { "class": "normal",      "target": "resolve" },
  "delete":        { "class": "destructive", "target": "resolve" },
  "link":          { "class": "normal",      "target": "required" },
  "note":          { "class": "normal",      "target": "required" },
  "delegate":      { "class": "normal",      "target": "create" }
}
```

- **`resolve`** — free text names the card. Open target → narrow model pick
  (`resolveCardRef`: whole deck, margin gate, "did you mean" suggestions on park).
  Covers move/promote/backlog, tag/untag, highlight/unhighlight, delete.
- **`create`** — free text is the brief; the work creates its own workspace. Open target
  → create a card from the text, then run the action against it. `@local what is a
  screencast?` ⇒ card `what-is-a-screencast`, delegation to local, artifact lands, feed
  notifies on done. This is the async-research flow as a *declaration*, not a rule — the
  engine's existing create-then-delegate motion (`create X @local`) is the implementation.
- **`required`** — free text is content, so there is no card query to extract. Open
  target parks loud: `note needs a #card`, `link needs two #cards`.
- **`none`** — create has no target.

An unknown `target` value in registry.json throws at startup (no-fallbacks rule).

## What the engine's middle becomes

```
pre-pass (meta: clean)                                 [unchanged]
→ pre-resolved frontmatter? execute                    [unchanged]
→ fork: command | create
→ command: parse → fill open slots:
     target per policy: resolve → resolveCardRef (one model question)
                        create  → handleCreate from text, then act
                        required→ park with the grammar error
     status: $sigil or verb sugar only — open status parks ('move needs a $status')
     executor: @sigil or bare collaborator word only — open executor parks
→ freeze check, destructive confirmation gate          [unchanged]
→ execute via handlers                                 [unchanged]
```

## Deletions

The spec earns its keep here — removed outright:

- `resolve.ts`: `resolveInstruction`, `ACTION_DESCRIPTIONS`, the action question, the
  status question. `resolveCardRef` survives as the one model call in the system.
- `split.ts` and the splitter pipeline step (compound *sentences* are captured as one
  card; compound *commands* were never a thing).
- `engine.ts`: the broad-path branch (`via: 'ai'` resolution), `delegate()`'s
  resolver-picked executor (delegate without a collaborator now parks at parse).
- `config.json thresholds`: `action` and `status` keys — only `card` remains. Startup
  validation accepts-and-ignores the old keys with a console warning (hand-edited
  configs are first-class; don't brick them).
- Tests covering all of the above; engine tests asserting the decline-to-AI flow.

## Telemetry and markers

There is no "AI path" anymore — there is a deterministic path with at most one
model-answered slot.

- `via: cli` — every slot bound by grammar/convention/default. Marker `›_`.
- `via: cli+ai` — the target was model-picked. Marker `›_✦`. The drawer names the slot
  and the pick: `card ← laya 0.93`.
- `via: ai` appears only in pre-existing history files; surfaces keep rendering its `✦`
  marker for those rows, nothing new emits it.
- Engine/model/version/duration fields unchanged.

## Edge cases (behavioral contract)

| input | outcome |
|---|---|
| `@local what is a screencast?` | card `what-is-a-screencast` + delegation to local, `via: cli` |
| `promote the munich thing` | narrow pick over the deck → move; park with suggestions below gate |
| `gotta fix the balcony door before winter` | card, due extracted, `via: cli` |
| `the munich thing is done` | a card titled that — mutation requires a verb |
| `note that we should ship` | parks: `note needs a #card` (no silent reinterpretation) |
| `move fast` (wanted as a card title) | parks: `move needs a $status`; capture with `create move fast` |
| `what is a screencast?` (no `@`) | a card — a question pushed at the system is capture |
| `delete the press thing` | narrow pick, then the existing confirmation gate (destructive class unchanged) |
| `@bob do something` (unknown collaborator) | not a fork trigger (only *configured* collaborators fork) → captured as a card; the typo is immediately visible on the board |

## Testing

- `cli.test.ts`: fork behavior — verb-first grammar failures return `error` (not
  `declined`) on bare input; non-verb input is never parsed as a command.
- `engine.test.ts`: create default for language; delegate open-target creates then
  delegates (single card, action advances to `delegate` in frontmatter — crash-replay
  safe, reuse the existing create-with-`with` test shape); `required` parks; `resolve`
  narrow pick unchanged; no resolver call on any path but `resolveCardRef`.
- Deleted suites: `split.test.ts`, `resolve.test.ts` action/status cases.
- Gate unchanged: typecheck, eslint max-warnings 0, vitest.
