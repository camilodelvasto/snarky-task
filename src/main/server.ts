import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'fs'
import { join, extname, sep } from 'path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { z } from 'zod'
import { readSnapshot } from './tasks/snapshot'
import { writeInstruction, readCard, readInstruction } from './tasks/files'
import { handleRename } from './tasks/handlers'
import type { Engine } from './tasks/engine'
import type { TaskdeckConfig } from './tasks/types'

export interface ServerOptions {
  tasksDir: () => string
  engine: () => Engine
  surfacesDir: string
  screenshot: () => Promise<string>
  /** Presentation config surfaced to the UIs (from config.json `ui`). */
  ui: () => TaskdeckConfig['ui']
  project: () => { current: string; list: string[]; templates: string[] }
  port?: number
}

export interface ServerHandle {
  port: number
  broadcast: () => void
  close: () => Promise<void>
}

const PORT = Number(process.env.XWEB_MCP_PORT) || 7920

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.woff2': 'font/woff2'
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function parseBody<T>(req: IncomingMessage, res: ServerResponse): Promise<T | null> {
  const raw = await readBody(req)
  try {
    return JSON.parse(raw) as T
  } catch {
    json(res, 400, { error: 'invalid JSON' })
    return null
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function notFound(res: ServerResponse): void {
  res.writeHead(404)
  res.end('Not found')
}

export async function startServer(opts: ServerOptions): Promise<ServerHandle> {
  const { tasksDir, engine, surfacesDir, screenshot, ui, project } = opts
  const port = opts.port ?? PORT

  const sseClients = new Set<ServerResponse>()

  function broadcast(): void {
    if (sseClients.size === 0) return
    const snap = JSON.stringify({
      ...readSnapshot(tasksDir()),
      ui: ui(),
      project: project(),
      nav: engine().getNav(),
      open: engine().getOpenCard()
    })
    const msg = `data: ${snap}\n\n`
    for (const res of sseClients) {
      try {
        res.write(msg)
      } catch {
        sseClients.delete(res)
        res.destroy()
      }
    }
  }

  // MCP: per-connection server pattern
  const transports = new Map<string, SSEServerTransport>()

  function buildMcpServer(): McpServer {
    const server = new McpServer({ name: 'snarky-task', version: '0.1.0' })

    server.tool(
      'task',
      'Queue an instruction for the snarky-task engine',
      { instruction: z.string() },
      async ({ instruction }) => {
        try {
          const id = writeInstruction(tasksDir(), instruction, new Date())
          return { content: [{ type: 'text' as const, text: JSON.stringify({ id }) }] }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          return {
            content: [{ type: 'text' as const, text: `Error: ${message}` }],
            isError: true
          }
        }
      }
    )

    server.tool('screenshot', 'Capture a screenshot of the current board view', {}, async () => {
      try {
        const data = await screenshot()
        return {
          content: [{ type: 'image' as const, data, mimeType: 'image/png' as const }]
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return {
          content: [{ type: 'text' as const, text: `Error: ${message}` }],
          isError: true
        }
      }
    })

    return server
  }

  function serveStatic(res: ServerResponse, surfaceName: string, subpath: string): void {
    // surfaceName is 'feed' or 'board'; subpath is the rest after /feed or /board
    const base = join(surfacesDir, surfaceName)
    let filePath = join(base, subpath || 'index.html')

    // Default to index.html for directory-like paths
    if (filePath.endsWith('/') || !extname(filePath)) {
      filePath = join(filePath.endsWith('/') ? filePath : filePath + '/', 'index.html')
    }

    // Security: ensure the resolved path is within surfacesDir (not just a prefix match)
    if (!filePath.startsWith(surfacesDir + sep)) {
      res.writeHead(403)
      res.end('Forbidden')
      return
    }

    if (!existsSync(filePath)) {
      notFound(res)
      return
    }

    const ext = extname(filePath)
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream'
    try {
      const content = readFileSync(filePath)
      res.writeHead(200, { 'Content-Type': contentType })
      res.end(content)
    } catch {
      notFound(res)
    }
  }

  const httpServer = createServer()

  httpServer.on('request', async (req, res) => {
    const rawUrl = req.url || '/'
    const url = new URL(rawUrl, `http://127.0.0.1:${port}`)
    const pathname = url.pathname

    try {
      // --- API routes ---

      if (pathname === '/api/state' && req.method === 'GET') {
        json(res, 200, {
          ...readSnapshot(tasksDir()),
          ui: ui(),
          project: project(),
          nav: engine().getNav(),
          open: engine().getOpenCard()
        })
        return
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive'
        })
        res.write('\n') // flush headers
        sseClients.add(res)
        // Send current state immediately
        const snap = JSON.stringify({
          ...readSnapshot(tasksDir()),
          ui: ui(),
          project: project(),
          nav: engine().getNav(),
          open: engine().getOpenCard()
        })
        res.write(`data: ${snap}\n\n`)
        req.on('close', () => sseClients.delete(res))
        return
      }

      // The board reports its currently-open card (click / open / close) so the
      // feed can target it when a card-verb is typed without a #ref. Transient,
      // in-memory, per-device — never written to the workspace.
      if (pathname === '/api/open' && req.method === 'POST') {
        const body = await parseBody<{ card?: string | null }>(req, res)
        if (body === null) return
        engine().setOpenCard(body.card ?? null)
        json(res, 200, { ok: true })
        return
      }

      if (pathname === '/api/instructions' && req.method === 'POST') {
        const body = await parseBody<{
          text?: string
          action?: string
          card?: string
          to?: string
          tags?: string[]
        }>(req, res)
        if (body === null) return
        if (!body.text) {
          json(res, 400, { error: 'text is required' })
          return
        }
        // Deterministic surface actions (board drop) send their resolution along — the
        // engine skips the CLI parser for these but keeps every downstream gate.
        const resolved =
          typeof body.action === 'string'
            ? { action: body.action, card: body.card, to: body.to, tags: body.tags }
            : undefined
        const id = writeInstruction(tasksDir(), body.text, new Date(), resolved)
        json(res, 201, { id })
        return
      }

      const instrMatch = pathname.match(/^\/api\/instructions\/([^/]+)$/)
      if (instrMatch && req.method === 'POST') {
        const id = instrMatch[1]
        const body = await parseBody<{ action?: string; text?: string }>(req, res)
        if (body === null) return
        const action = body.action

        if (action === 'confirm') {
          try {
            await engine().confirm(id)
            json(res, 200, { ok: true })
          } catch (err) {
            json(res, 400, { error: err instanceof Error ? err.message : String(err) })
          }
          return
        }
        if (action === 'reject') {
          const rqpath = join(tasksDir(), 'queue', `${id}.md`)
          if (!existsSync(rqpath)) {
            json(res, 400, { error: `instruction not found: ${id}` })
            return
          }
          engine().reject(id)
          json(res, 200, { ok: true })
          return
        }
        if (action === 'requeue') {
          const rqpath = join(tasksDir(), 'queue', `${id}.md`)
          if (!existsSync(rqpath)) {
            json(res, 400, { error: `instruction not found: ${id}` })
            return
          }
          engine().requeue(id, body.text)
          json(res, 200, { ok: true })
          return
        }
        if (action === 'delete') {
          const qpath = join(tasksDir(), 'queue', `${id}.md`)
          if (!existsSync(qpath)) {
            json(res, 400, { error: `instruction not found: ${id}` })
            return
          }
          engine().deleteInstruction(id)
          json(res, 200, { ok: true })
          return
        }
        json(res, 400, { error: `unknown action: ${action}` })
        return
      }

      if (pathname === '/api/history' && req.method === 'GET') {
        const dir = join(tasksDir(), 'history')
        const list = existsSync(dir)
          ? readdirSync(dir)
              .filter((f) => f.endsWith('.md'))
              .sort()
              .reverse()
              .slice(0, 200)
              .map((f) => {
                try {
                  return readInstruction(join(dir, f))
                } catch {
                  return null
                }
              })
              .filter(Boolean)
          : []
        json(res, 200, list)
        return
      }

      const artMatch = pathname.match(/^\/api\/artifacts\/([^/]+)\/([^/]+)$/)
      if (artMatch && req.method === 'POST') {
        const dir = join(tasksDir(), 'artifacts', decodeURIComponent(artMatch[1]))
        const filePath = join(dir, decodeURIComponent(artMatch[2]))
        // Traversal guard + no file creation through this door — edit-only.
        if (!filePath.startsWith(dir + sep) || !existsSync(filePath)) {
          notFound(res)
          return
        }
        const body = await parseBody<{ content?: string }>(req, res)
        if (body === null) return
        if (typeof body.content !== 'string') {
          json(res, 400, { error: 'content (string) required' })
          return
        }
        writeFileSync(filePath, body.content)
        json(res, 200, { ok: true })
        return
      }
      if (artMatch && req.method === 'GET') {
        const dir = join(tasksDir(), 'artifacts', decodeURIComponent(artMatch[1]))
        const filePath = join(dir, decodeURIComponent(artMatch[2]))
        // Traversal guard: the resolved path must stay inside this card's artifact dir
        if (!filePath.startsWith(dir + sep) || !existsSync(filePath)) {
          notFound(res)
          return
        }
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' })
        res.end(readFileSync(filePath))
        return
      }
      if (artMatch && req.method === 'DELETE') {
        const card = decodeURIComponent(artMatch[1])
        const file = decodeURIComponent(artMatch[2])
        const dir = join(tasksDir(), 'artifacts', card)
        const filePath = join(dir, file)
        // Traversal guard: the resolved path must stay inside this card's artifact dir.
        if (!filePath.startsWith(dir + sep) || !existsSync(filePath)) {
          notFound(res)
          return
        }
        // Recoverable drop through the engine — SAME path element drops take: move to
        // .trash, record for undo (POST /api/cards/:card/restore), and log on the card.
        // Chained per-card so it can't interleave with an in-flight write. onChange
        // inside dropOutput refreshes the snapshot, so no explicit broadcast here.
        try {
          await engine().dropOutput(card, file)
          json(res, 200, { ok: true })
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      // Collection route (no filename): author a blank artifact by hand. Routed
      // through the engine so the card log is stamped and the row surfaces — the
      // per-file POST above stays edit-only.
      const artCreateMatch = pathname.match(/^\/api\/artifacts\/([^/]+)$/)
      if (artCreateMatch && req.method === 'POST') {
        try {
          const file = engine().createArtifact(decodeURIComponent(artCreateMatch[1]))
          json(res, 201, { file })
        } catch (err) {
          json(res, 404, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      // Declarative element op from the open card (edit/scratch/drop/add). The
      // engine reads the card, applies the pure op, writes + logs. Throws (→ 400)
      // on a missing card or an op the type doesn't declare — never silent.
      const cardOpMatch = pathname.match(/^\/api\/cards\/([^/]+)\/op$/)
      if (cardOpMatch && req.method === 'POST') {
        const shortname = decodeURIComponent(cardOpMatch[1])
        const body = await parseBody<{ type?: string; op?: string; id?: string; text?: string }>(
          req,
          res
        )
        if (body === null) return
        if (!body.type || !body.op) {
          json(res, 400, { error: 'element op needs type and op' })
          return
        }
        try {
          await engine().applyElementOp(shortname, body.type, body.op, {
            id: body.id,
            text: body.text
          })
          json(res, 200, { ok: true })
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      // Undo the most recent drop (element or output) on a card.
      const restoreMatch = pathname.match(/^\/api\/cards\/([^/]+)\/restore$/)
      if (restoreMatch && req.method === 'POST') {
        const shortname = decodeURIComponent(restoreMatch[1])
        try {
          await engine().restoreLastDrop(shortname)
          json(res, 200, { ok: true })
        } catch (err) {
          json(res, 400, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      const cardMatch = pathname.match(/^\/api\/cards\/([^/]+)$/)
      if (cardMatch && req.method === 'POST') {
        const shortname = cardMatch[1]
        const body = await parseBody<{ action?: string; description?: string; title?: string }>(
          req,
          res
        )
        if (body === null) return

        if (body.action === 'delete') {
          // Route through the queue — no privileged side door
          writeInstruction(tasksDir(), `delete #${shortname}`, new Date())
          json(res, 200, { ok: true })
          return
        }

        if (body.description !== undefined || body.title !== undefined) {
          if (body.title !== undefined && !body.title.trim()) {
            json(res, 400, { error: 'title cannot be empty' })
            return
          }
          const cardPath = join(tasksDir(), 'cards', `${shortname}.md`)
          if (!existsSync(cardPath)) {
            json(res, 400, { error: `card not found: ${shortname}` })
            return
          }
          const card = readCard(cardPath)
          // Description first (in place), so a following reslug copies it along.
          // Route through the element op so it updates the lead text element
          // rather than the create-only legacy reconcile (which no-ops when a
          // lead already exists).
          if (body.description !== undefined)
            await engine().applyElementOp(shortname, 'text', 'edit', { text: body.description })
          // A title change lets the slug follow: handleRename reslugs via
          // copy/delete when the title maps to a new id, or updates in place when
          // it maps back to the same one. Only run it when the title actually changed.
          let shortnameOut = shortname
          if (body.title !== undefined && body.title !== card.title)
            shortnameOut = handleRename(
              { tasksDir: tasksDir(), now: new Date() },
              shortname,
              body.title
            )
          json(res, 200, { ok: true, shortname: shortnameOut })
          return
        }

        json(res, 400, { error: 'expected action, description, or title' })
        return
      }

      // --- Static surfaces ---

      const feedMatch = pathname.match(/^\/feed(\/.*)?$/)
      if (feedMatch) {
        serveStatic(res, 'feed', feedMatch[1] ?? '/')
        return
      }

      const boardMatch = pathname.match(/^\/board(\/.*)?$/)
      if (boardMatch) {
        serveStatic(res, 'board', boardMatch[1] ?? '/')
        return
      }

      const fontsMatch = pathname.match(/^\/fonts(\/.*)?$/)
      if (fontsMatch) {
        serveStatic(res, 'fonts', fontsMatch[1] ?? '/')
        return
      }

      // --- MCP SSE ---

      if (pathname === '/sse' && req.method === 'GET') {
        try {
          const transport = new SSEServerTransport('/messages', res)
          transports.set(transport.sessionId, transport)
          res.on('close', () => transports.delete(transport.sessionId))
          await buildMcpServer().connect(transport)
        } catch (err) {
          console.error('MCP SSE connection error:', err)
          if (!res.headersSent) {
            res.writeHead(500)
            res.end('SSE connection failed')
          }
        }
        return
      }

      if (pathname === '/messages' && req.method === 'POST') {
        const sessionId = url.searchParams.get('sessionId')
        const transport = sessionId ? transports.get(sessionId) : undefined
        if (transport) {
          await transport.handlePostMessage(req, res)
        } else {
          res.writeHead(404)
          res.end('Session not found')
        }
        return
      }

      notFound(res)
    } catch (err) {
      console.error('server request error:', err)
      if (!res.headersSent) {
        res.writeHead(500)
        res.end('Internal server error')
      }
    }
  })

  const actualPort = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, '127.0.0.1', () => {
      const addr = httpServer.address()
      resolve(typeof addr === 'object' && addr ? addr.port : port)
    })
  })

  return {
    port: actualPort,
    broadcast,
    close: () => {
      // Drain SSE clients so keep-alive connections don't block httpServer.close()
      for (const res of sseClients) {
        try {
          res.end()
        } catch {
          res.destroy()
        }
      }
      sseClients.clear()
      return new Promise<void>((resolve, reject) =>
        httpServer.close((err) => (err ? reject(err) : resolve()))
      )
    }
  }
}
