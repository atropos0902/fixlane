import { createHash, timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import { Draft, Proposal, Repo, RepoMode, type ToClient, ToServer } from '@fixlane/core'
import { BadSignature } from '@fixlane/hosts'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import pg from 'pg'
import { type WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import { Refused, type Service } from './service.ts'

export interface ServerOptions {
  service: Service
  /** name -> token */
  users: Record<string, string>
  port: number
  hostname?: string
}

const hash = (s: string): Buffer => createHash('sha256').update(s).digest()

const Take = z.object({ ticket: z.string(), session: z.string().max(64), force: z.boolean().default(false) })
const Epoch = z.object({ ticket: z.string(), epoch: z.number().int().positive() })
export class SyncServer {
  readonly #o: ServerOptions
  readonly #users: [string, Buffer][]
  readonly #sockets = new Map<WebSocket, { after: number; busy: boolean; again: boolean }>()
  #http!: Server
  #wss!: WebSocketServer
  #listener: pg.Client | null = null
  #closed = false

  constructor(o: ServerOptions) {
    this.#o = o
    this.#users = Object.entries(o.users).map(([n, t]) => [n, hash(t)])
  }

  #who(header: string | undefined): string | null {
    const got = hash((header ?? '').replace(/^Bearer /, ''))
    let who: string | null = null
    for (const [name, want] of this.#users) if (timingSafeEqual(got, want)) who = name
    return who
  }

  #app(): Hono<{ Variables: { user: string } }> {
    const s = this.#o.service
    const app = new Hono<{ Variables: { user: string } }>()
    app.onError((e, c) => {
      if (e instanceof BadSignature) return c.json({ error: 'bad signature' }, 401)
      if (e instanceof Refused) return c.json({ error: e.message }, 409)
      if (e instanceof z.ZodError) return c.json({ error: z.prettifyError(e) }, 400)
      return c.json({ error: 'server error' }, 500)
    })
    app.get('/health', (c) => c.text('ok'))
    app.post('/hooks/:kind', async (c) => {
      const kind = c.req.param('kind')
      const h = s.host(kind).readHook(c.req.header(), await c.req.text())
      if (h) await s.hook(kind, h)
      return c.json({})
    })
    app.use('/v1/*', async (c, next) => {
      const who = this.#who(c.req.header('authorization'))
      if (!who) return c.json({ error: 'who are you' }, 401)
      c.set('user', who)
      return next()
    })
    app.post('/v1/repos', async (c) => {
      await s.addRepo(c.get('user'), Repo.parse(await c.req.json()))
      return c.json({})
    })
    app.post('/v1/repos/:name/mode', async (c) => {
      const { mode } = z.object({ mode: RepoMode }).parse(await c.req.json())
      await s.setMode(c.get('user'), c.req.param('name'), mode)
      return c.json({})
    })
    app.post('/v1/append', async (c) =>
      c.json({ seq: await s.append(c.get('user'), Draft.parse(await c.req.json())) }),
    )
    app.post('/v1/lease/take', async (c) => {
      const b = Take.parse(await c.req.json())
      return c.json(await s.take(c.get('user'), b.ticket, b.session, b.force))
    })
    app.post('/v1/lease/renew', async (c) => {
      const b = Epoch.parse(await c.req.json())
      return c.json({ ok: await s.renew(b.ticket, b.epoch) })
    })
    app.post('/v1/lease/release', async (c) => {
      const b = Epoch.parse(await c.req.json())
      await s.release(c.get('user'), b.ticket, b.epoch)
      return c.json({})
    })
    app.post('/v1/propose', async (c) =>
      c.json(await s.propose(c.get('user'), Proposal.parse(await c.req.json()))),
    )
    return app
  }

  async start(): Promise<void> {
    await this.#o.service.db.init()
    await this.#listen()
    const http = await new Promise<Server>((r) => {
      const srv = serve(
        { fetch: this.#app().fetch, port: this.#o.port, hostname: this.#o.hostname ?? '127.0.0.1' },
        () => r(srv as Server),
      )
    })
    this.#http = http
    this.#wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
    http.on('upgrade', (req, socket, head) => {
      const who = this.#who(req.headers.authorization)
      if (!who || req.url !== '/v1/stream') {
        socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
        return
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#connected(ws, who))
    })
  }

  get origin(): string {
    const a = this.#http.address()
    return `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`
  }

  /** Postgres tells every server process about new entries, including the ones it wrote itself. */
  async #listen(): Promise<void> {
    const c = new pg.Client({ connectionString: this.#o.service.db.url })
    c.on('notification', () => this.#wake())
    c.on('error', () => {})
    c.on('end', () => {
      if (this.#closed) return
      setTimeout(
        () =>
          void this.#listen().then(
            () => this.#wake(),
            () => {},
          ),
        500,
      )
    })
    await c.connect()
    await c.query('LISTEN entries')
    this.#listener = c
  }

  #wake(): void {
    for (const ws of this.#sockets.keys()) void this.#feed(ws)
  }

  async #feed(ws: WebSocket): Promise<void> {
    const s = this.#sockets.get(ws)
    if (!s) return
    if (s.busy) {
      s.again = true
      return
    }
    s.busy = true
    try {
      do {
        s.again = false
        for (;;) {
          const entries = await this.#o.service.db.after(s.after)
          if (entries.length === 0) break
          s.after = entries.at(-1)!.seq
          this.#send(ws, { t: 'entries', entries })
        }
      } while (s.again)
    } catch {
      ws.close(1011)
    } finally {
      s.busy = false
    }
  }

  #send(ws: WebSocket, m: ToClient): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
  }

  #connected(ws: WebSocket, who: string): void {
    ws.on('error', () => {})
    ws.on('close', () => this.#sockets.delete(ws))
    ws.on('message', async (raw) => {
      let m: ToServer
      try {
        m = ToServer.parse(JSON.parse(String(raw)))
      } catch {
        ws.close(1008)
        return
      }
      if (m.t === 'hello') {
        this.#sockets.set(ws, { after: m.after, busy: false, again: false })
        await this.#feed(ws)
        return
      }
      const { clientId } = m.draft
      try {
        this.#send(ws, { t: 'ack', clientId, seq: await this.#o.service.append(who, m.draft) })
      } catch (e) {
        if (e instanceof Refused) this.#send(ws, { t: 'refused', clientId, reason: e.message })
        else ws.close(1011) // not its fault: it keeps the draft and sends it again
      }
    })
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const ws of this.#wss.clients) ws.terminate()
    this.#http.closeAllConnections()
    this.#http.close()
    await this.#listener?.end()
    await this.#o.service.db.close()
  }
}
