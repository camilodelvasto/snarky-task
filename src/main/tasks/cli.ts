import type { Dates } from '../capabilities/contracts'
import type { RegistryAliases, TargetPolicy, Scope } from './types'

export interface CliDeps {
  shortnames: Set<string> // existing card shortnames, lowercase
  statuses: string[] // registry.update_status.params.status
  aliases: RegistryAliases // verb → synonyms
  collaborators: string[] // Object.keys(config.collaborators ?? {})
  highlightLabels: string[] // config.ui.highlight_labels — powers highlight/unhighlight
  dates: Dates
  now: Date
  targetPolicy: Record<string, TargetPolicy> // per-action open-target policy (keyed by action)
}

export const SCOPES: Scope[] = ['card', 'full', 'board']

export interface CliCommand {
  action:
    | 'create'
    | 'update_status'
    | 'note'
    | 'link'
    | 'delete'
    | 'delegate'
    | 'label'
    | 'unlabel'
    | 'rename'
    | 'open'
  card?: string
  card2?: string
  to?: string
  title?: string
  desc?: string
  tags: string[]
  due?: string
  with?: string
  scope?: Scope // how much context a delegation carries: card (default) | full | board
}

export type ProjectOp =
  | { op: 'list' }
  | { op: 'switch'; name: string }
  | { op: 'new'; name: string; template?: string }
  | { op: 'rm'; name: string }

export type CliResult =
  | { kind: 'claimed'; cmd: CliCommand }
  // Partial decline: verb + args parsed deterministically, only the card
  // reference stayed fuzzy — the engine asks the resolver the one narrow
  // question ("which card does `query` mean?") and keeps cmd as decided.
  | { kind: 'needs-card'; cmd: CliCommand; query: string }
  // First token is not a command verb — input is language; engine captures it as a card.
  | { kind: 'declined' }
  // Command grammar failure (bare or slash-forced) — fork is final; parks in attention.
  | { kind: 'error'; error: string }
  // Project verb
  | { kind: 'project'; project: ProjectOp }

const VERBS = [
  'create',
  'move',
  'promote',
  'backlog',
  'tag',
  'untag',
  'highlight',
  'unhighlight',
  'note',
  'link',
  'delete',
  'delegate',
  'rename',
  'open'
] as const
type Verb = (typeof VERBS)[number]

const ACTION: Record<Verb, CliCommand['action']> = {
  create: 'create',
  move: 'update_status',
  promote: 'update_status', // promote #card — sugar for move #card $active
  backlog: 'update_status', // backlog #card — sugar for move #card $inbox
  tag: 'label', // tag #card #a #b — add labels
  untag: 'unlabel', // untag #card #a — remove labels
  highlight: 'label', // highlight #card — adds the first configured highlight label
  unhighlight: 'unlabel', // unhighlight #card — removes it
  note: 'note',
  link: 'link',
  delete: 'delete',
  delegate: 'delegate',
  rename: 'rename', // rename #card <new title> — slug follows (copy/delete)
  open: 'open' // open #card — UI nav; opens the card on the board
}

const NEEDS_CARD: Verb[] = [
  'move',
  'promote',
  'backlog',
  'tag',
  'untag',
  'highlight',
  'unhighlight',
  'note',
  'link',
  'delete',
  'delegate',
  'rename',
  'open'
]
const TAKES_TEXT: Verb[] = ['create', 'note', 'delegate', 'rename']

/** Normalize to the full-field shape every CliResult carries (consistent matching). */
function finalize(c: CliCommand): CliCommand {
  return {
    action: c.action,
    tags: c.tags,
    card: c.card,
    card2: c.card2,
    to: c.to,
    title: c.title,
    desc: c.desc,
    due: c.due,
    with: c.with,
    scope: c.scope
  }
}

function resolveVerb(token: string, aliases: RegistryAliases): Verb | undefined {
  const t = token.toLowerCase()
  if ((VERBS as readonly string[]).includes(t)) return t as Verb
  for (const [verb, syns] of Object.entries(aliases))
    if (syns.includes(t) && (VERBS as readonly string[]).includes(verb)) return verb as Verb
  return undefined
}

export function parseCommand(raw: string, deps: CliDeps): CliResult {
  const forced = raw.trimStart().startsWith('/')
  const input = forced ? raw.trimStart().slice(1) : raw
  const [first, ...restLines] = input.split('\n')
  const tokens = first.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0)
    return forced ? { kind: 'error', error: 'empty command' } : { kind: 'declined' }

  // Project verb: parse before verb resolution
  const SLUG = /^[a-z0-9-]+$/
  if (tokens[0].toLowerCase() === 'project' || tokens[0].toLowerCase() === 'projects') {
    const t = tokens.slice(1)
    const bad = (msg: string): CliResult => ({ kind: 'error', error: msg })
    if (t.length === 0) return { kind: 'project', project: { op: 'list' } }
    if (t[0] === 'new') {
      if (!t[1]) return bad('project new needs a name — `project new <slug> [--template <t>]`')
      if (!SLUG.test(t[1])) return bad(`project name must be a slug ([a-z0-9-]): "${t[1]}"`)
      const rest = t.slice(2)
      if (rest.length === 0) return { kind: 'project', project: { op: 'new', name: t[1] } }
      if (
        (rest[0] === '--template' || rest[0] === 'from') &&
        rest[1] &&
        SLUG.test(rest[1]) &&
        rest.length === 2
      )
        return { kind: 'project', project: { op: 'new', name: t[1], template: rest[1] } }
      return bad(`project new: cannot parse "${rest.join(' ')}"`)
    }
    if (t[0] === 'rm') {
      if (!t[1] || !SLUG.test(t[1]) || t.length > 2)
        return bad('project rm needs one project name — `project rm <slug>`')
      return { kind: 'project', project: { op: 'rm', name: t[1] } }
    }
    if (t.length === 1 && SLUG.test(t[0]))
      return { kind: 'project', project: { op: 'switch', name: t[0] } }
    return bad(`project: cannot parse "${t.join(' ')}"`)
  }

  let verb = resolveVerb(tokens[0], deps.aliases)
  let args = tokens.slice(1)
  // Explicit capture: a leading '+' files the line as a card, routed through the
  // same grammar as `create` (#tags, $due, free text → title; rest lines → desc).
  // This is the ONLY way bare text becomes a card — unmarked non-command input
  // declines and parks (the engine no longer silently captures).
  if (!verb && !forced && tokens[0] === '+') {
    verb = 'create'
    args = tokens.slice(1)
  } else if (!verb && !forced && tokens[0].startsWith('+') && tokens[0].length > 1) {
    verb = 'create'
    args = [tokens[0].slice(1), ...tokens.slice(1)]
  }
  // Leading @collaborator is an implicit delegate (spec: "bare @claude draft
  // the outline") — keep the token so the sigil loop binds --with from it.
  if (
    !verb &&
    tokens[0].startsWith('@') &&
    deps.collaborators.includes(tokens[0].slice(1).toLowerCase())
  ) {
    verb = 'delegate'
    args = tokens
  }
  if (!verb)
    return forced
      ? { kind: 'error', error: `unknown command "${tokens[0]}"` }
      : { kind: 'declined' }
  // Fork is final: once a verb is bound, grammar failures are always errors regardless
  // of whether input was slash-forced. The pre-verb paths (empty input, unknown first
  // token, unknown leading @word) keep their declined/forced-error behavior untouched.
  const fail = (msg: string): CliResult => ({ kind: 'error', error: msg })

  const cmd: CliCommand = { action: ACTION[verb], tags: [] }
  const free: string[] = []

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]
    if (tok.startsWith('--')) {
      // canonical long flag: consume value tokens until the next --flag
      const flag = tok.slice(2)
      const val: string[] = []
      while (i + 1 < args.length && !args[i + 1].startsWith('--')) val.push(args[++i])
      const v = val.join(' ')
      if (flag === 'title' || flag === 'text') free.push(v)
      else if (flag === 'desc') cmd.desc = v
      else if (flag === 'tag')
        cmd.tags.push(
          ...v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        )
      else if (flag === 'status') {
        if (!deps.statuses.includes(v)) return fail(`"${v}" is not a status`)
        cmd.to = v
      } else if (flag === 'with') {
        if (!deps.collaborators.includes(v)) return fail(`unknown collaborator "${v}"`)
        cmd.with = v
      } else if (flag === 'due') {
        const { due } = deps.dates.extract(v, deps.now)
        if (!due) return fail(`cannot parse date "${v}"`)
        cmd.due = due
      } else if (flag === 'card') {
        if (!deps.shortnames.has(v.toLowerCase())) return fail(`no card "#${v}"`)
        if (!cmd.card) cmd.card = v.toLowerCase()
        else cmd.card2 = v.toLowerCase()
      } else if (flag === 'scope') {
        if (!(SCOPES as string[]).includes(v))
          return fail(`"${v}" is not a scope — use card, full, or board`)
        cmd.scope = v as Scope
      } else return fail(`unknown flag --${flag}`)
    } else if (tok.startsWith('$') && tok.length > 1) {
      const word = tok.slice(1)
      if (deps.statuses.includes(word)) cmd.to = word
      else {
        const { due } = deps.dates.extract(word, deps.now)
        if (!due) return fail(`"$${word}" is neither a status nor a date`)
        cmd.due = due
      }
    } else if (tok.startsWith('@') && tok.length > 1) {
      const name = tok.slice(1)
      if (!deps.collaborators.includes(name)) return fail(`unknown collaborator "@${name}"`)
      cmd.with = name
    } else if (tok.startsWith('^') && tok.length > 1) {
      const word = tok.slice(1)
      if (!(SCOPES as string[]).includes(word))
        return fail(`"^${word}" is not a scope — use ^card, ^full, or ^board`)
      cmd.scope = word as Scope
    } else if (tok.startsWith('#') && tok.length > 1) {
      const word = tok.slice(1).toLowerCase()
      const isRef = verb !== 'create' && deps.shortnames.has(word)
      if (isRef && !cmd.card) cmd.card = word
      else if (isRef && verb === 'link' && !cmd.card2) cmd.card2 = word
      else cmd.tags.push(word)
    } else {
      free.push(tok)
    }
  }

  // Free text always goes to title (when non-empty)
  const text = free.join(' ')
  if (text) cmd.title = text
  const desc = restLines.join('\n').trim()
  if (desc) cmd.desc = cmd.desc ? `${cmd.desc}\n${desc}` : desc

  // Multiline note: text on continuation lines is still the note text —
  // `note #card ⏎ the thought` must not fail "note needs text". Folded to one
  // line because a note is a single log entry.
  if (verb === 'note' && !cmd.title && cmd.desc) {
    cmd.title = cmd.desc.replace(/\s*\n+\s*/g, ' ').trim()
    cmd.desc = undefined
  }

  // Bare collaborator on delegate: a free-text word that exactly matches a
  // configured collaborator binds --with (config-derived lookup, no model).
  if (verb === 'delegate' && !cmd.with && free.length) {
    const idx = free.findIndex((w) => deps.collaborators.includes(w.toLowerCase()))
    if (idx !== -1) {
      cmd.with = free[idx].toLowerCase()
      free.splice(idx, 1)
      cmd.title = free.join(' ') || undefined
    }
  }

  // Bare card reference: for verbs with a 'resolve' target policy, the text itself
  // may name the card — bind it when its slug exactly matches one shortname.
  // Deterministic (a filesystem-derived lookup, same spirit as #ref-if-exists);
  // no match → the input partially declines to the resolver as a narrow card pick.
  if (!cmd.card && text && deps.targetPolicy[ACTION[verb]] === 'resolve') {
    const slug = text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (deps.shortnames.has(slug)) {
      cmd.card = slug
      cmd.title = undefined
    } else if (slug) {
      // Unique-prefix match: still deterministic — binds only when exactly one
      // shortname starts with the slug (titles get cut at the 48-char slug cap,
      // so a typed full title is often a prefix of its own shortname).
      const matches = [...deps.shortnames].filter((n) => n.startsWith(slug))
      if (matches.length === 1) {
        cmd.card = matches[0]
        cmd.title = undefined
      }
    }
  }

  // per-verb grammar requirements
  if (verb === 'promote') cmd.to = 'active'
  if (verb === 'backlog') cmd.to = 'inbox'
  if (verb === 'highlight' || verb === 'unhighlight') {
    if (!deps.highlightLabels.length)
      return fail('no highlight label configured — set ui.highlight_labels in config.json')
    cmd.tags = [deps.highlightLabels[0]]
  }
  if ((verb === 'tag' || verb === 'untag') && cmd.tags.length === 0)
    return fail(`${verb} needs #tags — e.g. \`${verb} #card #highlight\``)
  if (verb === 'note' && !cmd.title) return fail('note needs text')
  if (verb === 'move' && !cmd.to) return fail('move needs a $status')
  if (NEEDS_CARD.includes(verb) && !cmd.card) {
    const policy = deps.targetPolicy[ACTION[verb]] ?? 'required'
    // resolve: free text names the card — narrow model pick (bare input only;
    // `/` promises no model and fails loud).
    if (policy === 'resolve' && text && !forced)
      return { kind: 'needs-card', cmd: finalize({ ...cmd, title: undefined }), query: text }
    // create: free text is the brief — the work creates its own workspace.
    if (policy === 'create' && cmd.title) {
      if (verb === 'delegate' && !cmd.with) return fail('delegate needs a @collaborator')
      return { kind: 'claimed', cmd: finalize(cmd) }
    }
    return fail(`${verb} needs a #card`)
  }
  if (verb === 'create' && !cmd.title) return fail('create needs a title')
  if (verb === 'link' && !cmd.card2) return fail('link needs two #cards')
  if (verb === 'delegate' && !cmd.with) return fail('delegate needs a @collaborator')
  if (!TAKES_TEXT.includes(verb) && cmd.title) return fail(`${verb} takes no free text`)

  return { kind: 'claimed', cmd: finalize(cmd) }
}
