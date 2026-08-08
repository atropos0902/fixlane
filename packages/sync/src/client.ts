import { EventEmitter } from 'node:events'
import {
  type Draft,
  type LogEntry,
  type Proposal,
  type Proposed,
  type Repo,
  type RepoMode,
  ToClient,
  type ToServer,
} from '@fixlane/core'
import { WebSocket } from 'ws'

/** What the client keeps on disk. The daemon does this with SQLite. */
export interface Local {
  cursor(): number
  add(entries: LogEntry[]): void
  queue(d: Draft): void
  queued(): Draft[]
  unqueue(clientId: string): void
}

export interface ClientEvents {
  entries: [LogEntry[]]
  refused: [{ clientId: string; reason: string }]
  online: [boolean]
}

/** Works offline: drafts wait in the outbox and go out, in order, once there is a connection. */
export class SyncClient extends EventEmitter<ClientEvents> {
  readonly #origin: string
  readonly #token: string
  readonly #local: Local
  #ws: WebSocket | null = null
  #timer: NodeJS.Timeout | null = null
  #misses = 0
  #on = false
  #sending: string | null = null

  constructor(origin: string, token: string, local: Local) {
    super()
    this.#origin = origin
    this.#token = token
    this.#local = local
  }

  get online(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN
  }

  connect(): void {
    this.#on = true
    const ws = new WebSocket(`${this.#origin.replace(/^http/, 'ws')}/v1/stream`, {
      headers: { authorization: `Bearer ${this.#token}` },
      handshakeTimeout: 5000,
    })
    this.#ws = ws
    ws.on('open', () => {
      this.#misses = 0
      this.#send({ t: 'hello', after: this.#local.cursor() })
      this.emit('online', true)
      this.#flush()
    })
    ws.on('message', (raw) => this.#got(ToClient.parse(JSON.parse(String(raw)))))
    ws.on('error', () => {})
    ws.on('close', () => {
      if (this.#ws !== ws) return
      this.#sending = null
      this.emit('online', false)
      if (!this.#on) return
      const wait = Math.min(200 * 2 ** this.#misses++, 10_000) * (0.5 + Math.random() / 2)
      this.#timer = setTimeout(() => this.connect(), wait)
    })
  }

  disconnect(): void {
    this.#on = false
    if (this.#timer) clearTimeout(this.#timer)
    const ws = this.#ws
    this.#ws = null
    this.#sending = null
    ws?.terminate()
  }

  append(d: Draft): void {
    this.#local.queue(d)
    this.#flush()
  }

  #send(m: ToServer): void {
    this.#ws?.send(JSON.stringify(m))
  }

  /** One at a time, so that they arrive in the order they were made. */
  #flush(): void {
    if (!this.online || this.#sending) return
    const next = this.#local.queued()[0]
    if (!next) return
    this.#sending = next.clientId
    this.#send({ t: 'append', draft: next })
  }

  #got(m: ToClient): void {
    if (m.t === 'entries') {
      this.#local.add(m.entries)
      this.emit('entries', m.entries)
      return
    }
    this.#local.unqueue(m.clientId)
    if (m.t === 'refused') this.emit('refused', { clientId: m.clientId, reason: m.reason })
    this.#sending = null
    this.#flush()
  }

  async #post<T>(path: string, body: unknown): Promise<T> {
    const r = await fetch(`${this.#origin}/v1/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.#token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
    const j = (await r.json()) as T & { error?: string }
    if (!r.ok) throw new Error(j.error ?? `sync server: ${r.status}`)
    return j
  }

  addRepo(r: Repo): Promise<unknown> {
    return this.#post('repos', r)
  }
  setMode(repo: string, mode: RepoMode): Promise<unknown> {
    return this.#post(`repos/${repo}/mode`, { mode })
  }
  take(ticket: string, session: string, force: boolean): Promise<{ epoch: number } | { heldBy: string }> {
    return this.#post('lease/take', { ticket, session, force })
  }
  async renew(ticket: string, epoch: number): Promise<boolean> {
    return (await this.#post<{ ok: boolean }>('lease/renew', { ticket, epoch })).ok
  }
  release(ticket: string, epoch: number): Promise<unknown> {
    return this.#post('lease/release', { ticket, epoch })
  }
  propose(p: Proposal): Promise<Proposed> {
    return this.#post('propose', p)
  }
}
