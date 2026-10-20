import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { startServer } from '../server'
import { writeCard, readInstruction, readCard } from '../tasks/files'
import { readSnapshot } from '../tasks/snapshot'

let base: string
let close: () => Promise<void>
let tasksDir: string
let surfacesDir: string

const fakeEngine = {
  confirm: async () => undefined,
  reject: () => undefined,
  requeue: () => undefined,
  getNav: () => undefined
} as never

const fakeProject = { current: 'default', list: ['default'], templates: [] }

function makeTmpServer(): ReturnType<typeof startServer> {
  const td = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const s of ['queue', 'cards', 'artifacts']) mkdirSync(join(td, s), { recursive: true })
  const sd = mkdtempSync(join(tmpdir(), 'surf-'))
  mkdirSync(join(sd, 'feed'))
  writeFileSync(join(sd, 'feed', 'index.html'), '<html>feed</html>')
  return startServer({
    tasksDir: () => td,
    engine: () => fakeEngine,
    surfacesDir: sd,
    screenshot: async () => 'base64png',
    ui: () => ({ highlight_labels: ['highlight'] }),
    project: () => fakeProject,
    port: 0
  })
}

beforeAll(async () => {
  tasksDir = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
  for (const s of ['queue', 'cards', 'artifacts']) mkdirSync(join(tasksDir, s), { recursive: true })
  surfacesDir = mkdtempSync(join(tmpdir(), 'surf-'))
  mkdirSync(join(surfacesDir, 'feed'))
  writeFileSync(join(surfacesDir, 'feed', 'index.html'), '<html>feed</html>')
  mkdirSync(join(surfacesDir, 'fonts'))
  writeFileSync(join(surfacesDir, 'fonts', 'EBGaramond-Variable.woff2'), Buffer.from([0, 1, 2, 3]))
  const server = await startServer({
    tasksDir: () => tasksDir,
    engine: () => fakeEngine,
    surfacesDir,
    screenshot: async () => 'base64png',
    ui: () => ({ highlight_labels: ['highlight'] }),
    project: () => fakeProject,
    port: 0
  })
  base = `http://127.0.0.1:${server.port}`
  close = server.close
})
afterAll(async () => close())

describe('api', () => {
  it('POST /api/instructions writes a queue file', async () => {
    const res = await fetch(`${base}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'hello world task' })
    })
    expect(res.status).toBe(201)
    const { id } = await res.json()
    expect(readInstruction(join(tasksDir, 'queue', `${id}.md`)).raw).toBe('hello world task')
  })
  it('GET /api/state returns the snapshot', async () => {
    writeCard(tasksDir, {
      shortname: 'c1',
      title: 'C1',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const snap = await (await fetch(`${base}/api/state`)).json()
    expect(snap.cards.map((c: { shortname: string }) => c.shortname)).toContain('c1')
  })
  it('card POST title change reslugs: old file gone, new slug carries the title', async () => {
    writeCard(tasksDir, {
      shortname: 'x',
      title: 'Old',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: 'keep me',
      log: []
    })
    const res = await fetch(`${base}/api/cards/x`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New title' })
    })
    expect(res.status).toBe(200)
    expect((await res.json()).shortname).toBe('new-title')
    expect(existsSync(join(tasksDir, 'cards', 'x.md'))).toBe(false)
    const nw = readCard(join(tasksDir, 'cards', 'new-title.md'))
    expect(nw.title).toBe('New title')
    expect(nw.description).toBe('keep me')
  })
  it('card POST with a same-slug title stays in place', async () => {
    writeCard(tasksDir, {
      shortname: 'press-plan',
      title: 'press plan',
      status: 'inbox',
      created: '2026-10-01',
      links: [],
      labels: [],
      description: '',
      log: []
    })
    const res = await fetch(`${base}/api/cards/press-plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Press Plan' })
    })
    expect((await res.json()).shortname).toBe('press-plan')
    expect(readCard(join(tasksDir, 'cards', 'press-plan.md')).title).toBe('Press Plan')
  })
  it('card delete routes through the queue, not a side door', async () => {
    const res = await fetch(`${base}/api/cards/c1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete' })
    })
    expect(res.status).toBe(200)
    const snap = readSnapshot(tasksDir)
    expect(snap.instructions.some((i) => i.raw === 'delete #c1')).toBe(true)
  })
  it('POST /api/artifacts/:card creates a blank artifact through the engine', async () => {
    const td = join(mkdtempSync(join(tmpdir(), 'td-')), 'tasks')
    for (const s of ['queue', 'cards', 'artifacts']) mkdirSync(join(td, s), { recursive: true })
    const sd = mkdtempSync(join(tmpdir(), 'surf-'))
    mkdirSync(join(sd, 'feed'))
    writeFileSync(join(sd, 'feed', 'index.html'), '<html>feed</html>')
    let calledWith = ''
    const spyEngine = {
      getNav: () => undefined,
      confirm: async () => undefined,
      reject: () => undefined,
      requeue: () => undefined,
      createArtifact: (c: string) => {
        calledWith = c
        return '2026-10-02T10-00-00.md'
      }
    } as never
    const srv = await startServer({
      tasksDir: () => td,
      engine: () => spyEngine,
      surfacesDir: sd,
      screenshot: async () => 'x',
      ui: () => ({ highlight_labels: [] }),
      project: () => fakeProject,
      port: 0
    })
    try {
      const res = await fetch(`http://127.0.0.1:${srv.port}/api/artifacts/draft`, {
        method: 'POST'
      })
      expect(res.status).toBe(201)
      expect(await res.json()).toEqual({ file: '2026-10-02T10-00-00.md' })
      expect(calledWith).toBe('draft')
    } finally {
      await srv.close()
    }
  })
  it('serves the feed surface', async () => {
    expect(await (await fetch(`${base}/feed/`)).text()).toContain('feed')
  })
  it('rejects unknown instruction actions with 400', async () => {
    const res = await fetch(`${base}/api/instructions/xyz`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'explode' })
    })
    expect(res.status).toBe(400)
  })
  it('exposes ui config in the state snapshot and SSE payloads', async () => {
    const res = await fetch(`${base}/api/state`)
    const snap = await res.json()
    expect(snap.ui).toEqual({ highlight_labels: ['highlight'] })
  })
  it('snapshot carries project info', async () => {
    const res = await fetch(`${base}/api/state`)
    const snap = await res.json()
    expect(snap.project).toEqual({ current: 'default', list: ['default'], templates: [] })
  })
  it('serves vendored fonts with the woff2 mime type', async () => {
    const res = await fetch(`${base}/fonts/EBGaramond-Variable.woff2`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('font/woff2')
  })
  it('rejects font path traversal', async () => {
    const res = await fetch(`${base}/fonts/../board/board.js`)
    expect([400, 403, 404]).toContain(res.status)
  })
})

describe('security', () => {
  it('path traversal via /feed/../../package.json returns 403 or 404, never file contents', async () => {
    const res = await fetch(`${base}/feed/../../package.json`)
    expect([403, 404]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('"name"')
  })
  it('percent-encoded path traversal /feed/%2e%2e%2fpackage.json returns 403 or 404', async () => {
    const res = await fetch(`${base}/feed/%2e%2e%2fpackage.json`)
    expect([403, 404]).toContain(res.status)
    const body = await res.text()
    expect(body).not.toContain('"name"')
  })
})

describe('bad JSON', () => {
  it('POST /api/instructions with malformed JSON returns 400', async () => {
    const res = await fetch(`${base}/api/instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json'
    })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe('invalid JSON')
  })
})

describe('close with active SSE client', () => {
  it('close() resolves even when an SSE client is connected', async () => {
    const server = await makeTmpServer()
    const sseBase = `http://127.0.0.1:${server.port}`

    // Open an SSE connection and keep it alive
    const controller = new AbortController()
    const ssePromise = fetch(`${sseBase}/api/events`, { signal: controller.signal }).catch(
      () => null
    )

    // Give the connection time to register
    await new Promise((r) => setTimeout(r, 50))

    // close() must resolve within 2 seconds despite the hanging SSE connection
    await Promise.race([
      server.close(),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('close() timed out')), 2000)
      )
    ])

    controller.abort()
    await ssePromise
  })
})

describe('artifacts', () => {
  it('serves artifact content as text and guards traversal', async () => {
    mkdirSync(join(tasksDir, 'artifacts', 'proto'), { recursive: true })
    writeFileSync(join(tasksDir, 'artifacts', 'proto', 'out.md'), '# research\nfindings')
    const ok = await fetch(`${base}/api/artifacts/proto/out.md`)
    expect(ok.status).toBe(200)
    expect(await ok.text()).toContain('findings')
    const bad = await fetch(`${base}/api/artifacts/proto/..%2F..%2Fconfig.json`)
    expect([400, 403, 404]).toContain(bad.status)
  })
  it('POST saves an edit; guards traversal and missing files', async () => {
    mkdirSync(join(tasksDir, 'artifacts', 'proto'), { recursive: true })
    writeFileSync(join(tasksDir, 'artifacts', 'proto', 'edit.md'), 'before')
    const ok = await fetch(`${base}/api/artifacts/proto/edit.md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# after' })
    })
    expect(ok.status).toBe(200)
    expect(readFileSync(join(tasksDir, 'artifacts', 'proto', 'edit.md'), 'utf-8')).toBe('# after')
    // edit-only door: no file creation
    const ghost = await fetch(`${base}/api/artifacts/proto/ghost.md`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' })
    })
    expect(ghost.status).toBe(404)
    const trav = await fetch(`${base}/api/artifacts/proto/..%2F..%2Fconfig.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'x' })
    })
    expect([400, 403, 404]).toContain(trav.status)
  })
})

describe('history', () => {
  it('GET /api/history returns swept instructions, newest first', async () => {
    mkdirSync(join(tasksDir, 'history'), { recursive: true })
    writeFileSync(
      join(tasksDir, 'history', '2026-10-01T10-00-00-aaaa.md'),
      '---\nstatus: done\nengine: cli\n---\n\nolder one\n'
    )
    writeFileSync(
      join(tasksDir, 'history', '2026-10-02T10-00-00-bbbb.md'),
      '---\nstatus: done\n---\n\nnewer one\n'
    )
    const res = await fetch(`${base}/api/history`)
    expect(res.status).toBe(200)
    const list = await res.json()
    expect(list[0].raw).toBe('newer one')
    expect(list[1].raw).toBe('older one')
    expect(list[1].engine).toBe('cli')
  })
})
