import { randomUUID } from 'node:crypto'
import { chmodSync, rmSync } from 'node:fs'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { type Card, type Draft, Repo, RepoMode, type SessionState, Ticket } from '@fixlane/core'
import type { SyncClient } from '@fixlane/sync'
import { getRequestListener } from '@hono/node-server'
import { Hono } from 'hono'
import pty from 'node-pty'
import { type WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import type { Coordinator, LocalBoard } from './coordinator.ts'
import type { Engine } from './engine.ts'
import type { Session, Verdict } from './store.ts'

/** A ticket as the desktop shows it: what the team sees, plus the session on this machine. */
export interface TicketView extends Omit<Card, 'state' | 'note'> {
  state: SessionState | 'open'
  note: string | null
  local: Session | null
  mine: boolean
}
export interface StateView {
  online: boolean | null
  repos: Repo[]
  tickets: TicketView[]
  runtimes: ('claude' | 'codex' | 'replay')[]
}
export interface SessionView {
  session: Session
  moves: { was: string; now: string }[]
  lines: { attempt: number; n: number; line: unknown }[]
  verdict: Verdict | null
  diff: string | null
  reviewDir: string | null
}

export interface ApiOptions {
  engine: Engine
  coordinator: Coordinator
  board: LocalBoard | null
  client: SyncClient | null
  me: string
  runtimes: StateView['runtimes']
}

export class Api {
  readonly #o: ApiOptions
  readonly #http: Server
  readonly #stream = new WebSocketServer({ noServer: true })
  readonly #terms = new WebSocketServer({ noServer: true })

  constructor(o: ApiOptions) {
    this.#o = o
    this.#http = createServer(getRequestListener(this.#app().fetch))
    this.#http.on('upgrade', (req, socket, head) => {
      const term = /^\/v1\/sessions\/([0-9a-f]+)\/terminal$/.exec(req.url ?? '')
      if (term) this.#terms.handleUpgrade(req, socket, head, (ws) => void this.#terminal(ws, term[1]!))
      else if (req.url === '/v1/stream') this.#stream.handleUpgrade(req, socket, head, () => {})
      else socket.destroy()
    })
    const tell = (m: unknown): void => {
      for (const ws of this.#stream.clients) ws.send(JSON.stringify(m))
    }
    const { store } = o.engine
    store.on('session', (s) => tell({ t: 'session', session: s }))
    store.on('line', (l) => tell({ t: 'line', ...l }))
    store.on('board', () => tell({ t: 'board' }))
    o.client?.on('online', () => tell({ t: 'board' }))
  }

  #state(): StateView {
    const { engine, board, client, me, runtimes } = this.#o
    const last = new Map<string, Session>()
    for (const s of engine.store.sessions()) last.set(s.ticket, s)
    const bare = (t: Ticket): Card => ({
      ticket: t,
      epoch: 0,
      holder: null,
      session: null,
      state: null,
      note: null,
      pull: null,
      comments: [],
    })
    const tickets = engine.store.tickets().map((t): TicketView => {
      const card = board?.board.cards.get(t.id) ?? bare(t)
      const local = last.get(t.id) ?? null
      // The board is ahead when another desktop has taken the ticket since.
      const mine = local !== null && (local.epoch ?? card.epoch) >= card.epoch
      const state = mine ? local.state : (card.state ?? 'open')
      const note = mine ? (local.reason ?? local.note ?? local.feedback) : card.note
      return {
        ...card,
        state,
        note,
        pull: mine ? (card.pull ?? local.pull) : card.pull,
        holder: mine ? me : card.holder,
        local,
        mine,
      }
    })
    return { online: client ? client.online : null, repos: engine.store.repos(), tickets, runtimes }
  }

  #app(): Hono {
    const { engine, coordinator, client } = this.#o
    const { store } = engine
    const app = new Hono()
    app.onError((e, c) => c.json({ error: e instanceof z.ZodError ? z.prettifyError(e) : e.message }, 400))
    const need = (id: string): Session => {
      const s = store.session(id)
      if (!s) throw new Error(`no session ${id}`)
      return s
    }
    const ticket = (id: string): Ticket => {
      const t = store.ticket(id)
      if (!t) throw new Error(`no ticket ${id}`)
      return t
    }
    const say = (d: Draft): void => client?.append(d)

    app.get('/v1/state', (c) => c.json(this.#state()))
    app.get('/v1/sessions/:id', async (c) => {
      const s = need(c.req.param('id'))
      const repo = store.repo(s.repo)
      const diff =
        repo && s.base && s.head
          ? await (await engine.mirror(repo)).diff(s.base, s.head).catch(() => null)
          : null
      const view: SessionView = {
        session: s,
        moves: store.moves(s.id),
        lines: store.lines(s.id),
        verdict: store.verdict(s.id),
        diff,
        reviewDir: s.state === 'in_review' ? engine.reviewDir(s) : null,
      }
      return c.json(view)
    })
    app.post('/v1/repos', async (c) => {
      const r = Repo.parse(await c.req.json())
      if (client) await client.addRepo(r)
      else store.putRepo(r)
      return c.json({})
    })
    app.post('/v1/repos/:name/mode', async (c) => {
      const { mode } = z.object({ mode: RepoMode }).parse(await c.req.json())
      await coordinator.setMode(c.req.param('name'), mode)
      return c.json({})
    })
    app.post('/v1/tickets', async (c) => {
      const t = Ticket.parse(await c.req.json())
      if (store.ticket(t.id)) throw new Error(`ticket ${t.id} exists`)
      store.putTicket(t)
      say({ type: 'ticket.filed', ticket: t.id, clientId: randomUUID(), data: t })
      return c.json({})
    })
    app.post('/v1/tickets/:id/comment', async (c) => {
      const { text } = z.object({ text: z.string().min(1).max(4000) }).parse(await c.req.json())
      say({
        type: 'ticket.commented',
        ticket: ticket(c.req.param('id')).id,
        clientId: randomUUID(),
        data: { text },
      })
      return c.json({})
    })
    app.post('/v1/tickets/:id/replay', async (c) => {
      store.putReplay(ticket(c.req.param('id')).id, z.array(z.unknown()).parse(await c.req.json()))
      return c.json({})
    })
    const Start = z.object({
      runtime: z.enum(['claude', 'codex', 'replay']),
      moveHere: z.boolean().default(false),
    })
    app.post('/v1/tickets/:id/start', async (c) => {
      const b = Start.parse(await c.req.json())
      const t = ticket(c.req.param('id'))
      return c.json(b.moveHere ? await engine.moveHere(t, b.runtime) : engine.submit(t, b.runtime))
    })
    app.post('/v1/sessions/:id/cancel', async (c) => {
      await engine.cancel(need(c.req.param('id')).id, this.#o.me)
      return c.json({})
    })
    return app
  }

  /** Taking over: the agent freezes, and a shell in its container is on the line until it hangs up. */
  async #terminal(ws: WebSocket, id: string): Promise<void> {
    const { engine } = this.#o
    let name: string
    try {
      name = await engine.pause(id)
    } catch (e) {
      ws.close(1008, (e as Error).message)
      return
    }
    const p = pty.spawn('docker', ['exec', '-it', '-e', 'TERM=xterm-256color', name, 'bash'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      env: { PATH: process.env.PATH, HOME: process.env.HOME } as Record<string, string>,
    })
    p.onData((d) => ws.readyState === ws.OPEN && ws.send(d))
    p.onExit(() => ws.close())
    ws.on('message', (raw) => {
      const m = z
        .union([
          z.object({ data: z.string() }),
          z.object({ cols: z.number().int().min(2).max(500), rows: z.number().int().min(2).max(300) }),
        ])
        .safeParse(JSON.parse(String(raw)))
      if (!m.success) return
      if ('data' in m.data) p.write(m.data.data)
      else p.resize(m.data.cols, m.data.rows)
    })
    ws.on('error', () => {})
    ws.on('close', () => {
      p.kill()
      engine.resume(id).catch(() => {})
    })
  }

  listen(path: string): Promise<void> {
    rmSync(path, { force: true })
    return new Promise((r) =>
      this.#http.listen(path, () => {
        chmodSync(path, 0o600)
        r()
      }),
    )
  }

  close(): void {
    for (const w of [...this.#stream.clients, ...this.#terms.clients]) w.terminate()
    this.#http.closeAllConnections()
    this.#http.close()
  }
}
