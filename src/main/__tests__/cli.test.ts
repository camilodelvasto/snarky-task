import { describe, it, expect } from 'vitest'
import { parseCommand } from '../tasks/cli'
import type { TargetPolicy } from '../tasks/types'

const deps = {
  shortnames: new Set(['press-plan', 'prototype']),
  highlightLabels: ['highlight'],
  statuses: ['inbox', 'active', 'waiting', 'done', 'dropped'],
  aliases: { create: ['add', 'new'], move: ['mv'], note: ['log'], delete: ['del', 'rm'] },
  collaborators: ['claude', 'local'],
  dates: {
    extract: (t: string) => (t === 'today' ? { due: '2026-10-03', cleaned: '' } : { cleaned: t })
  },
  now: new Date('2026-10-03T10:00:00'),
  targetPolicy: {
    create: 'none',
    update_status: 'resolve',
    label: 'resolve',
    unlabel: 'resolve',
    delete: 'resolve',
    open: 'resolve',
    rename: 'required',
    note: 'required',
    link: 'required',
    delegate: 'create'
  } as Record<string, TargetPolicy>
}

describe('parseCommand — claiming', () => {
  it('parses the spec worked example', () => {
    const r = parseCommand(
      'create submit proposal prototype #urgent $today $active @claude #offline',
      deps
    )
    expect(r).toEqual({
      kind: 'claimed',
      cmd: {
        action: 'create',
        title: 'submit proposal prototype',
        tags: ['urgent', 'offline'],
        due: '2026-10-03',
        to: 'active',
        with: 'claude'
      }
    })
  })
  it('maps aliases: "add" and "new" are create, "mv" is move', () => {
    expect(parseCommand('add ship it', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'create', title: 'ship it' }
    })
    expect(parseCommand('mv #press-plan $done', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'update_status', card: 'press-plan', to: 'done' }
    })
  })
  it('on create every # is a tag; on card verbs a matching # is the ref, non-matching are tags', () => {
    expect(parseCommand('create x #press-plan', deps)).toMatchObject({
      cmd: { action: 'create', tags: ['press-plan'] }
    })
    expect(parseCommand('note #press-plan remember the fonts #ui', deps)).toMatchObject({
      cmd: { action: 'note', card: 'press-plan', title: 'remember the fonts', tags: ['ui'] }
    })
  })
  it('note free text lands in title-free --text slot', () => {
    const r = parseCommand('note #press-plan remember the fonts', deps)
    expect(r).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'note', card: 'press-plan', desc: undefined }
    })
    // note text travels as cmd.title? NO — see Produces: note/delegate free text goes to cmd.title. Assert:
    expect((r as { cmd: { title?: string } }).cmd.title).toBe('remember the fonts')
  })
  it('link binds two existing refs', () => {
    expect(parseCommand('link #press-plan #prototype', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'link', card: 'press-plan', card2: 'prototype' }
    })
  })
  it('multiline note: continuation lines are the note text, not desc', () => {
    expect(
      parseCommand('note #press-plan\nremember the fonts\nand the spacing', deps)
    ).toMatchObject({
      kind: 'claimed',
      cmd: {
        action: 'note',
        card: 'press-plan',
        title: 'remember the fonts and the spacing',
        desc: undefined
      }
    })
  })
  it('multiline: lines after the first become desc', () => {
    const r = parseCommand('create ship it\nall the context\nsecond line', deps)
    expect(r).toMatchObject({
      kind: 'claimed',
      cmd: { title: 'ship it', desc: 'all the context\nsecond line' }
    })
  })
})

describe('parseCommand — open-card fallback', () => {
  const open = { ...deps, openCard: 'press-plan' }
  it('a card-verb with no #ref targets the open card', () => {
    expect(parseCommand('note remember the fonts', open)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'note', card: 'press-plan', title: 'remember the fonts' }
    })
  })
  it('an explicit #ref always wins over the open card', () => {
    expect(parseCommand('note #prototype the thing', open)).toMatchObject({
      cmd: { action: 'note', card: 'prototype' }
    })
  })
  it('does not fire for `open` — it resolves its own target, never the open card', () => {
    // 'somethingelse' is not a known card, so open goes to the resolver — it must
    // NOT silently bind the open card (press-plan).
    const r = parseCommand('open somethingelse', open)
    expect(r.kind).toBe('needs-card')
    expect(r).not.toMatchObject({ cmd: { card: 'press-plan' } })
  })
  it('with nothing open, a card-verb with no #ref still parks loud', () => {
    const r = parseCommand('note remember the fonts', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/note needs a #card/)
  })
})

describe('parseCommand — describe', () => {
  it('describe #card <text> puts the body in desc, no title', () => {
    expect(parseCommand('describe #press-plan the new body text', deps)).toEqual({
      kind: 'claimed',
      cmd: { action: 'describe', card: 'press-plan', desc: 'the new body text', tags: [] }
    })
  })
  it('folds continuation lines into desc', () => {
    expect(parseCommand('describe #press-plan line one\nline two', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'describe', card: 'press-plan', desc: 'line one\nline two' }
    })
  })
  it('without a #ref parks loud', () => {
    const r = parseCommand('describe just some text', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/describe needs a #card/)
  })
})

describe('parseCommand — reslug', () => {
  it('reslug #old #new claims with the new slug carried in title', () => {
    expect(parseCommand('reslug #press-plan #renamed', deps)).toEqual({
      kind: 'claimed',
      cmd: { action: 'reslug', card: 'press-plan', title: 'renamed', tags: [] }
    })
  })
  it('accepts a bare (unhashed) new slug', () => {
    expect(parseCommand('reslug #press-plan renamed', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'reslug', card: 'press-plan', title: 'renamed' }
    })
  })
  it('parks when the target slug already names a card', () => {
    const r = parseCommand('reslug #press-plan #prototype', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/already uses that slug/)
  })
  it('parks when the card to reslug does not exist', () => {
    const r = parseCommand('reslug #nope #x', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/no card "#nope"/)
  })
  it('parks when the new slug is missing', () => {
    const r = parseCommand('reslug #press-plan', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/reslug needs/)
  })
  it('parks when the new slug is not a valid slug', () => {
    const r = parseCommand('reslug #press-plan #bad_slug', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/not a valid slug/)
  })
})

describe('parseCommand — declining (bare)', () => {
  it('unknown verb declines', () => {
    expect(parseCommand('createx submit proposal', deps)).toEqual({ kind: 'declined' })
  })
  it('known verb with failed grammar: note without a #ref — fork is final, parks loud', () => {
    const r = parseCommand('note that we should ship', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/note needs a #card/)
  })
  it('bad $token is an error: not a status, not a date', () => {
    const r = parseCommand('create x $banana', deps)
    expect(r.kind).toBe('error')
  })
  it('unknown @collaborator is an error', () => {
    const r = parseCommand('create x @bob', deps)
    expect(r.kind).toBe('error')
  })
  it('plain language declines (the engine parks it; no silent card)', () => {
    expect(parseCommand('we should probably revisit the roadmap', deps)).toEqual({
      kind: 'declined'
    })
  })
})

describe('parseCommand — remove alias (→ delete, classifier for fuzzy refs)', () => {
  const d = { ...deps, aliases: { ...deps.aliases, delete: ['del', 'rm', 'drop', 'remove'] } }
  it('remove #ref → deterministic delete', () => {
    expect(parseCommand('remove #press-plan', d)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'delete', card: 'press-plan' }
    })
  })
  it('remove <exact slug> → deterministic delete', () => {
    expect(parseCommand('remove press plan', d)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'delete', card: 'press-plan' }
    })
  })
  it('remove <fuzzy text> → needs-card (goes to the classifier)', () => {
    expect(parseCommand('remove the card that says x', d)).toMatchObject({
      kind: 'needs-card',
      cmd: { action: 'delete' },
      query: 'the card that says x'
    })
  })
})

describe('parseCommand — rename (slug follows)', () => {
  it('rename #card <new title> claims a rename with the title as text', () => {
    expect(parseCommand('rename #press-plan Q4 Press Plan', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'rename', card: 'press-plan', title: 'Q4 Press Plan' }
    })
  })
  it('rename without a #card parks (required)', () => {
    const r = parseCommand('rename something new', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/rename needs a #card/)
  })
})

describe('parseCommand — open (UI nav)', () => {
  it('open #ref claims an open action', () => {
    expect(parseCommand('open #press-plan', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'open', card: 'press-plan' }
    })
  })
  it('expand is an alias for open', () => {
    const d = { ...deps, aliases: { ...deps.aliases, open: ['expand'] } }
    expect(parseCommand('expand #press-plan', d)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'open', card: 'press-plan' }
    })
  })
  it('open <fuzzy text> goes to the classifier (needs-card)', () => {
    expect(parseCommand('open the munich thing', deps)).toMatchObject({
      kind: 'needs-card',
      cmd: { action: 'open' },
      query: 'the munich thing'
    })
  })
})

describe('parseCommand — explicit capture (+)', () => {
  it('+ <text> claims a create, routed through the create grammar', () => {
    expect(parseCommand('+ buy milk', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'create', title: 'buy milk' }
    })
  })
  it('+<text> with no space also captures', () => {
    expect(parseCommand('+buy milk', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'create', title: 'buy milk' }
    })
  })
  it('+ honors create sigils: #tag and $due', () => {
    expect(parseCommand('+ call the plumber #urgent $today', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'create', title: 'call the plumber', tags: ['urgent'], due: '2026-10-03' }
    })
  })
  it('a bare + with no text errors (no blank card)', () => {
    expect(parseCommand('+', deps).kind).toBe('error')
  })
})

describe('parseCommand — slash-forced', () => {
  it('/create parses like bare create', () => {
    expect(parseCommand('/create ship it $active', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'create', to: 'active' }
    })
  })
  it('unknown /verb errors instead of declining', () => {
    const r = parseCommand('/createx ship it', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/unknown command "createx"/)
  })
  it('known /verb with failed grammar errors with the specific reason', () => {
    const r = parseCommand('/note missing the ref', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/note needs a #card/)
  })
  it('move without a status errors when forced', () => {
    const r = parseCommand('/move #press-plan', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/move needs a \$status/)
  })
  it('leftover free text on move errors when forced', () => {
    expect(parseCommand('/move #press-plan $done asap please', deps).kind).toBe('error')
  })
})

describe('parseCommand — canonical long flags', () => {
  it('parses --title/--status/--tag/--with/--due', () => {
    const r = parseCommand(
      'create --title ship the thing --tag a,b --status active --with claude --due today',
      deps
    )
    expect(r).toMatchObject({
      kind: 'claimed',
      cmd: {
        action: 'create',
        title: 'ship the thing',
        tags: ['a', 'b'],
        to: 'active',
        with: 'claude',
        due: '2026-10-03'
      }
    })
  })
})

describe('parseCommand — promote', () => {
  it('promote #card claims as update_status to active', () => {
    expect(parseCommand('promote #press-plan', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'update_status', card: 'press-plan', to: 'active' }
    })
  })
  it('/promote without a card errors', () => {
    const r = parseCommand('/promote', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/promote needs a #card/)
  })
  it('bare promote with free text errors — fork is final, no silent reinterpretation', () => {
    const r = parseCommand('promote #press-plan asap', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/promote takes no free text/)
  })
})

describe('parseCommand — promote/backlog aliases', () => {
  const d = {
    ...deps,
    aliases: { ...deps.aliases, promote: ['upgrade'], backlog: ['downgrade', 'demote'] }
  }
  it('upgrade resolves to promote (active), downgrade/demote to backlog (inbox)', () => {
    expect(parseCommand('upgrade #press-plan', d)).toMatchObject({
      cmd: { action: 'update_status', card: 'press-plan', to: 'active' }
    })
    expect(parseCommand('downgrade #press-plan', d)).toMatchObject({
      cmd: { action: 'update_status', card: 'press-plan', to: 'inbox' }
    })
    expect(parseCommand('demote #press-plan', d)).toMatchObject({
      cmd: { action: 'update_status', card: 'press-plan', to: 'inbox' }
    })
  })
})

describe('parseCommand — backlog', () => {
  it('backlog #card claims as update_status to inbox', () => {
    expect(parseCommand('backlog #press-plan', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'update_status', card: 'press-plan', to: 'inbox' }
    })
  })
  it('/backlog without a card errors', () => {
    const r = parseCommand('/backlog', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/backlog needs a #card/)
  })
})

describe('parseCommand — bare card references (slug match)', () => {
  const d = { ...deps, shortnames: new Set(['clean-the-house', 'press-plan']) }
  it('promote <title words> binds the card whose slug matches exactly', () => {
    expect(parseCommand('promote clean the house', d)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'update_status', card: 'clean-the-house', to: 'active', title: undefined }
    })
  })
  it('backlog and delete accept bare refs too', () => {
    expect(parseCommand('backlog clean the house', d)).toMatchObject({
      cmd: { action: 'update_status', card: 'clean-the-house', to: 'inbox' }
    })
    expect(parseCommand('delete clean the house', d)).toMatchObject({
      cmd: { action: 'delete', card: 'clean-the-house' }
    })
  })
  it('move with a bare ref still needs its $status', () => {
    expect(parseCommand('move clean the house $done', d)).toMatchObject({
      cmd: { action: 'update_status', card: 'clean-the-house', to: 'done' }
    })
  })
  it('non-matching text partially declines: verb kept, card reference handed to the resolver', () => {
    expect(parseCommand('promote the munich thing', d)).toMatchObject({
      kind: 'needs-card',
      cmd: { action: 'update_status', to: 'active', card: undefined, title: undefined },
      query: 'the munich thing'
    })
  })
  it('slash-forced input stays strict — no model, fails loud', () => {
    const r = parseCommand('/promote the munich thing', d)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/promote needs a #card/)
  })
  it('move with a fuzzy ref keeps its parsed $status in the partial decline', () => {
    expect(parseCommand('move the munich thing $done', d)).toMatchObject({
      kind: 'needs-card',
      cmd: { action: 'update_status', to: 'done' },
      query: 'the munich thing'
    })
  })
  it('move with a fuzzy ref but no $status errors — fork is final', () => {
    const r = parseCommand('move the munich thing', d)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/move needs a \$status/)
  })
})

describe('parseCommand — tag / untag', () => {
  it('tag #card #labels claims as label with tags', () => {
    expect(parseCommand('tag #press-plan #highlight #q4', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'label', card: 'press-plan', tags: ['highlight', 'q4'] }
    })
  })
  it('untag #card #label claims as unlabel', () => {
    expect(parseCommand('untag #press-plan #highlight', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'unlabel', card: 'press-plan', tags: ['highlight'] }
    })
  })
  it('/tag without tags errors', () => {
    const r = parseCommand('/tag #press-plan', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/tag needs #tags/)
  })
})

describe('parseCommand — highlight / unhighlight (declared label)', () => {
  it('highlight #card claims as label with the first configured highlight label', () => {
    expect(parseCommand('highlight #press-plan', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'label', card: 'press-plan', tags: ['highlight'] }
    })
  })
  it('bare title works via slug match: highlight publish new platform', () => {
    const d = { ...deps, shortnames: new Set(['publish-new-platform']) }
    expect(parseCommand('highlight publish new platform', d)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'label', card: 'publish-new-platform', tags: ['highlight'] }
    })
  })
  it('unhighlight removes the label', () => {
    expect(parseCommand('unhighlight #press-plan', deps)).toMatchObject({
      cmd: { action: 'unlabel', card: 'press-plan', tags: ['highlight'] }
    })
  })
  it('/highlight errors when no highlight label is configured', () => {
    const d = { ...deps, highlightLabels: [] }
    const r = parseCommand('/highlight #press-plan', d)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/no highlight label configured/)
  })
})

describe('parseCommand — bare collaborator name on delegate', () => {
  it('delegate #card claude binds the collaborator without @', () => {
    expect(parseCommand('delegate #press-plan claude', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'delegate', card: 'press-plan', with: 'claude', title: undefined }
    })
  })
  it('surrounding text stays as the delegation text', () => {
    expect(parseCommand('delegate #press-plan claude research the options', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'delegate', card: 'press-plan', with: 'claude', title: 'research the options' }
    })
  })
})

describe('parseCommand — drop alias and unique-prefix bare refs', () => {
  const d = {
    ...deps,
    aliases: { ...deps.aliases, delete: ['del', 'rm', 'drop'] },
    shortnames: new Set(['we-are-given-a-note-highlight-publish-new', 'press-plan'])
  }
  it('drop <partial title> binds when the slug is a unique prefix', () => {
    expect(parseCommand('drop we are given a note', d)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'delete', card: 'we-are-given-a-note-highlight-publish-new' }
    })
  })
  it('an ambiguous prefix (no exact match) partially declines to the card pick', () => {
    const amb = { ...d, shortnames: new Set(['press-plan-alpha', 'press-plan-beta']) }
    expect(parseCommand('drop press plan', amb)).toMatchObject({
      kind: 'needs-card',
      cmd: { action: 'delete', card: undefined },
      query: 'press plan'
    })
  })
  it('an exact match wins even when longer shortnames share the prefix', () => {
    const ex = { ...d, shortnames: new Set(['press-plan', 'press-plan-v2']) }
    expect(parseCommand('drop press plan', ex)).toMatchObject({
      cmd: { action: 'delete', card: 'press-plan' }
    })
  })
})

describe('parseCommand — leading @collaborator is an implicit delegate', () => {
  it('@claude <text> #card claims as delegate', () => {
    expect(parseCommand('@claude give me a brief overview #press-plan', deps)).toMatchObject({
      kind: 'claimed',
      cmd: {
        action: 'delegate',
        with: 'claude',
        card: 'press-plan',
        title: 'give me a brief overview'
      }
    })
  })
  it('unknown leading @name still declines', () => {
    expect(parseCommand('@bob do something #press-plan', deps)).toEqual({ kind: 'declined' })
  })
})

describe('parseCommand — fork is final + policy-driven open targets', () => {
  it('bare grammar failure parks loud — no silent reinterpretation as language', () => {
    const r = parseCommand('note that we should ship', deps)
    expect(r.kind).toBe('error')
    expect((r as { error: string }).error).toMatch(/note needs a #card/)
  })
  it('bare sigil failure parks loud too', () => {
    const r = parseCommand('create x $banana', deps)
    expect(r.kind).toBe('error')
  })
  it('non-verb input declines to capture', () => {
    expect(parseCommand('createx submit proposal', deps)).toEqual({ kind: 'declined' })
  })
  it('unknown @word is not a fork trigger — declines to capture', () => {
    expect(parseCommand('@bob do something #press-plan', deps)).toEqual({ kind: 'declined' })
  })
  it('delegate with text and no card claims — the work creates its own workspace', () => {
    expect(parseCommand('@local what is a screencast?', deps)).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'delegate', with: 'local', card: undefined, title: 'what is a screencast?' }
    })
  })
  it('delegate with neither card nor text still fails', () => {
    const r = parseCommand('@local', deps)
    expect(r.kind).toBe('error')
  })
})

describe('parseCommand — absent target defaults to required', () => {
  it('an action key absent from targetPolicy is treated as required — parks with <verb> needs a #card instead of claiming', () => {
    // A hand-edited registry.json may omit the target field for a custom action.
    // The engine maps absent entries to 'required' via (registry[k].target ?? 'required').
    // The CLI mirrors this: missing key in targetPolicy falls through to 'required' behaviour
    // and emits an error rather than silently claiming or creating.
    const d = {
      ...deps,
      // 'note' is not in this targetPolicy map at all — simulates a new/hand-edited action
      targetPolicy: {
        create: 'none',
        update_status: 'resolve',
        label: 'resolve',
        unlabel: 'resolve',
        delete: 'resolve',
        // note deliberately omitted
        link: 'required',
        delegate: 'create'
      } as Record<string, TargetPolicy>
    }
    // The card exists in shortnames, so this claims fine — the policy absence
    // only matters when NO card is resolved. Verify the absent-key path specifically:
    expect(parseCommand('note #press-plan is missing the card', d).kind).toBe('claimed')
    const r2 = parseCommand('note some bare text with no hash', d)
    expect(r2.kind).toBe('error')
    expect((r2 as { error: string }).error).toMatch(/note needs a #card/)
  })
})

describe('parseCommand — project verb', () => {
  it('project / projects list', () => {
    expect(parseCommand('projects', deps)).toEqual({ kind: 'project', project: { op: 'list' } })
    expect(parseCommand('project', deps)).toEqual({ kind: 'project', project: { op: 'list' } })
  })
  it('project <slug> switches', () => {
    expect(parseCommand('project house-renovation', deps)).toEqual({
      kind: 'project',
      project: { op: 'switch', name: 'house-renovation' }
    })
  })
  it('project new with --template and `from` sugar', () => {
    expect(parseCommand('project new house --template renovation', deps)).toEqual({
      kind: 'project',
      project: { op: 'new', name: 'house', template: 'renovation' }
    })
    expect(parseCommand('project new house from renovation', deps)).toEqual({
      kind: 'project',
      project: { op: 'new', name: 'house', template: 'renovation' }
    })
    expect(parseCommand('project new house', deps)).toEqual({
      kind: 'project',
      project: { op: 'new', name: 'house' }
    })
  })
  it('project rm <slug>', () => {
    expect(parseCommand('project rm house', deps)).toEqual({
      kind: 'project',
      project: { op: 'rm', name: 'house' }
    })
  })
  it('fork is final: bad grammar parks loud', () => {
    expect(parseCommand('project New House', deps).kind).toBe('error')
    expect(parseCommand('project new', deps).kind).toBe('error')
    expect(parseCommand('project house extra junk', deps).kind).toBe('error')
    expect(parseCommand('/project rm', deps).kind).toBe('error')
  })
})

describe('parseCommand — context scope sigil', () => {
  it('^full sets cmd.scope on a delegation', () => {
    const r = parseCommand('@claude review #prototype ^full', deps)
    expect(r).toMatchObject({
      kind: 'claimed',
      cmd: { action: 'delegate', with: 'claude', card: 'prototype', scope: 'full' }
    })
  })
  it('^board sets the broadest scope', () => {
    const r = parseCommand('delegate #prototype @claude ^board draft', deps)
    expect(r).toMatchObject({ kind: 'claimed', cmd: { scope: 'board' } })
  })
  it('--scope full is the long form', () => {
    const r = parseCommand('@claude review #prototype --scope full', deps)
    expect(r).toMatchObject({ kind: 'claimed', cmd: { scope: 'full' } })
  })
  it('no sigil leaves scope undefined (engine defaults to card)', () => {
    const r = parseCommand('@claude review #prototype', deps)
    expect((r as { cmd: { scope?: string } }).cmd.scope).toBeUndefined()
  })
  it('an unknown scope value parks loud', () => {
    expect(parseCommand('@claude review #prototype ^wat', deps)).toEqual({
      kind: 'error',
      error: '"^wat" is not a scope — use ^card, ^full, or ^board'
    })
  })
})
