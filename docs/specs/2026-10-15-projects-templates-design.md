# Projects & templates — design

**Date:** 2026-10-15
**Status:** draft for review
**Builds on:** slot-resolution spec (2026-10-06); files-are-state; no-fallbacks

## Purpose

One deck per concern — house renovation, business canvas, the default task list —
instead of one deck for everything. Projects are switchable from the console, listable,
removable, and creatable from templates so a new project starts useful, not empty.

## Model: a project is a workspace directory

The engine already binds everything to one tasks dir; a project pluralizes that.

```
workspace/
  current                     # ONE LINE: the active project name — the switch IS a file
  projects/
    default/tasks/            # config.json, registry.json, queue/ cards/ history/ artifacts/
    house-renovation/tasks/
  templates/
    gtd/cards/*.md            # seed decks: plain card files
    renovation/cards/*.md
    business-canvas/cards/*.md
    <name>/config.json        # optional per-template overrides; absent → copied from default
  .mcp.json
```

- `workspace/current` holds the active project name. Switching = writing that file —
  every input path (CLI verb, board switcher, hand-edit, partner's git pull) converges
  on the same state, and a watcher reconciles. Files are the state, including this one.
- Each project owns its full `tasks/` set, including `config.json` and `registry.json`
  (a canvas project can have different collaborators or aliases than the house one).
- **Migration (one-time, at boot):** if `workspace/tasks` exists and `workspace/projects`
  does not, move it to `workspace/projects/default/tasks` and write `current` = `default`.
  Hand-rollable backwards by moving it back.
- Project names are slugs (`[a-z0-9-]+`); anything else is a parse error.

## Verbs (CLI layer — `project` is a command, not a card action)

| input | effect |
|---|---|
| `project` or `projects` | list projects into the feed (active one marked) |
| `project <name>` | switch: write `workspace/current`, engine rebinds |
| `project new <name>` | create from the implicit `default` scaffold (empty deck) |
| `project new <name> --template <t>` (sugar: `project new <name> from <t>`) | create seeded from `workspace/templates/<t>/` |
| `project rm <name>` | **destructive → confirmation gate**; then the project dir moves to `workspace/.trash/<timestamp>-<name>/` — a wipe you can grep and undo. Removing the active project switches to `default` first; `default` itself is not removable. |

Parse rules: `project` is a new CLI verb with its own grammar (fork-is-final applies —
bad project grammar parks loud). Unknown target project on switch/rm parks with the real
error and the list of existing names. `/project …` works like every other forced command.

## Engine: a ProjectManager owns the running Engine

- Boot: read `workspace/current` (default `default`), construct Engine + capabilities
  against that project's tasks dir, start.
- Switch: `engine.stop()` → construct + start a fresh Engine on the new dir → server
  re-points its tasks dir → broadcast. In-flight instructions finish first (`drain()` with
  a timeout; stragglers are crash-safe by design — `working` reverts to `queued` at boot).
- A watcher on `workspace/current` makes hand edits and git pulls first-class switches.
- Per-project config means per-project capability bindings resolve at switch time; a
  binding that fails to load parks the switch in attention with the real error
  (no-fallbacks — a broken project must not silently half-open).

## Feed/board surfaces

- Snapshot/SSE gain `project: { current: string, list: string[] }`.
- Board topbar: the project name renders left of the view tabs; clicking it drops the
  list; picking one POSTs `project <name>` through the normal instruction door.
- Feed: autocomplete after `project ` offers names and templates; the listing output of
  `projects` renders as a done instruction row whose drawer shows the list (new optional
  `result` frontmatter field on instructions — generic, reusable later for delegations).

## Templates

- A template is a directory of card `.md` files plus optional `config.json` /
  `registry.json` overrides. Authoring one = copying a project you like into
  `workspace/templates/<name>/` and pruning.
- `project new` copies: template cards (with `created` reset to today, `log` reset to a
  single `created` line), config/registry from the template if present else from
  `default`'s current ones.
- Ship three starters in the repo (templates are tracked; only live project data is
  gitignored): `gtd` (inbox/waiting starter cards explaining the flow), `renovation`
  (phased: planning, permits, demolition, trades, finishing), `business-canvas` (nine
  canvas blocks as cards, labeled by block).

## Gitignore / sharing

- `.gitignore` moves from `workspace/tasks/*` rules to `workspace/projects/*` +
  `workspace/current` + `workspace/.trash/`; `workspace/templates/` stays tracked.
- Sharing a single project between machines (the partner-laptop case) = making one
  project dir its own git repo or Syncthing folder; the per-project boundary is exactly
  the sharing boundary. One-live-engine discipline still applies (see 2026-10-15 notes).

## Non-goals (this iteration)

- No per-instruction ownership / two live engines on one shared project.
- No cross-project card moves or links.
- No template marketplace mechanics — a template is a folder you copy.

## Testing

- CLI: `project` verb grammar (switch/new/rm/list, slug validation, `from` sugar).
- ProjectManager: boot migration; switch rebinds (instruction written pre-switch lands in
  old project, post-switch in new); rm is confirm-gated, trashes not deletes, guards
  `default` and the active project; broken per-project config parks the switch.
- Templates: `project new x --template gtd` seeds cards with reset created/log.
- Surfaces stay render-only (manual QA list).
