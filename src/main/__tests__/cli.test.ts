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
  it('multiline: lines after the first become desc', () => {
    const r = parseCommand('create ship it\nall the context\nsecond line', deps)
    expect(r).toMatchObject({
      kind: 'claimed',
      cmd: { title: 'ship it', desc: 'all the context\nsecond line' }
    })
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
  it('plain language declines', () => {
    expect(parseCommand('we should probably revisit the roadmap', deps)).toEqual({
      kind: 'declined'
    })
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
