import { randomUUID } from 'node:crypto'
import {
  apply,
  type Board,
  type Draft,
  emptyBoard,
  isOver,
  type Lease,
  type LogEntry,
  NO_LEASE,
  type Proposal,
  type Proposed,
  type Pull,
  type RepoMode,
  release,
  renew,
  take,
} from '@fixlane/core'
import type { GitHost } from '@fixlane/hosts'
import type { SyncClient } from '@fixlane/sync'
import type { Session, Store } from './store.ts'

/** Who may work on a ticket, and who opens its pull request. Alone, that is this machine. */
export interface Coordinator {
  take(ticket: string, session: string, force?: boolean): Promise<{ epoch: number } | { heldBy: string }>
  /** false when somebody else has the ticket now */
  renew(ticket: string, epoch: number): Promise<boolean>
  release(ticket: string, epoch: number): Promise<void>
  mode(repo: string): Promise<RepoMode>
  setMode(repo: string, mode: RepoMode): Promise<void>
  propose(p: Proposal): Promise<Proposed>
  pull(session: Session): Promise<Pull | null>
}

export class LocalCoordinator implements Coordinator {
  readonly #store: Store
  readonly #hosts: Record<string, GitHost>
  constructor(store: Store, hosts: Record<string, GitHost>) {
    this.#store = store
    this.#hosts = hosts
  }

  #lease(ticket: string): Lease {
    const r = this.#store.db.prepare('SELECT data FROM leases WHERE ticket = ?').get(ticket) as
      | { data: string }
      | undefined
    return r ? (JSON.parse(r.data) as Lease) : NO_LEASE
  }
  #put(ticket: string, l: Lease): void {
    this.#store.db.prepare('INSERT OR REPLACE INTO leases VALUES (?, ?)').run(ticket, JSON.stringify(l))
  }
  #host(repo: string): { host: GitHost; project: string; base: string } {
    const r = this.#store.repo(repo)
    const host = r ? this.#hosts[r.host] : undefined
    if (!r || !host) throw new Error(`no host for ${repo}`)
    return { host, project: r.project, base: r.base }
  }

  async take(
    ticket: string,
    session: string,
    force = false,
  ): Promise<{ epoch: number } | { heldBy: string }> {
    const r = take(this.#lease(ticket), 'this machine', session, Date.now(), force)
    if (!r.ok) return { heldBy: r.holder }
    this.#put(ticket, r.lease)
    return { epoch: r.lease.epoch }
  }
  async renew(ticket: string, epoch: number): Promise<boolean> {
    const l = renew(this.#lease(ticket), epoch, Date.now())
    if (l) this.#put(ticket, l)
    return l !== null
  }
  async release(ticket: string, epoch: number): Promise<void> {
    const l = release(this.#lease(ticket), epoch)
    if (l) this.#put(ticket, l)
  }
  async mode(repo: string): Promise<RepoMode> {
    return this.#store.repo(repo)?.mode ?? 'branch'
  }
  async setMode(repo: string, mode: RepoMode): Promise<void> {
    const r = this.#store.repo(repo)
    if (r) this.#store.putRepo({ ...r, mode })
  }
  async propose(p: Proposal): Promise<Proposed> {
    const { host, project, base } = this.#host(p.repo)
    if (this.#lease(p.ticket).epoch !== p.epoch) return { kind: 'stale' }
    if ((await this.mode(p.repo)) === 'branch') return { kind: 'branch-only' }
    return {
      kind: 'opened',
      pull: await host.openPull(project, { head: p.head, base, title: p.title, body: p.body }),
    }
  }
  async pull(s: Session): Promise<Pull | null> {
    if (!s.pull) return null
    const { host, project } = this.#host(s.repo)
    return host.getPull(project, s.pull.number)
  }
}

/** Keeps the shared board in the daemon's own database, so it is there without a connection. */
export class LocalBoard {
  readonly #store: Store
  board: Board = emptyBoard()
  constructor(store: Store) {
    this.#store = store
    const rows = store.db.prepare('SELECT data FROM entries ORDER BY seq').all() as { data: string }[]
    for (const r of rows) this.board = apply(this.board, JSON.parse(r.data) as LogEntry)
  }
  cursor(): number {
    return this.board.seq
  }
  add(entries: LogEntry[]): void {
    this.#store.db.transaction(() => {
      for (const e of entries) {
        if (e.seq <= this.board.seq) continue
        this.#store.db.prepare('INSERT OR IGNORE INTO entries VALUES (?, ?)').run(e.seq, JSON.stringify(e))
        this.board = apply(this.board, e)
        if (e.type === 'ticket.filed') this.#store.putTicket(e.data)
        if (e.type === 'repo.added') this.#store.putRepo(e.data)
        if (e.type === 'repo.mode') {
          const r = this.board.repos.get(e.data.repo)
          if (r) this.#store.putRepo(r)
        }
      }
    })()
    this.#store.emit('board')
  }
  queue(d: Draft): void {
    this.#store.db
      .prepare('INSERT OR IGNORE INTO outbox (clientId, draft) VALUES (?, ?)')
      .run(d.clientId, JSON.stringify(d))
  }
  queued(): Draft[] {
    const rows = this.#store.db.prepare('SELECT draft FROM outbox ORDER BY n LIMIT 1').all() as {
      draft: string
    }[]
    return rows.map((r) => JSON.parse(r.draft) as Draft)
  }
  unqueue(clientId: string): void {
    this.#store.db.prepare('DELETE FROM outbox WHERE clientId = ?').run(clientId)
  }
}

/** With a sync server, the server decides who has a ticket and it alone opens pull requests. */
export class SyncCoordinator implements Coordinator {
  readonly #client: SyncClient
  readonly #local: LocalBoard
  readonly #said = new Map<string, string>()

  constructor(client: SyncClient, local: LocalBoard, store: Store) {
    this.#client = client
    this.#local = local
    store.on('session', (s) => this.#tell(s))
  }

  #tell(s: Session): void {
    const now = `${s.state} ${s.attempt}`
    if (s.epoch === null || this.#said.get(s.id) === now) return
    this.#said.set(s.id, now)
    const note = isOver(s.state) ? s.reason : s.feedback
    this.#client.append({
      type: 'session.moved',
      ticket: s.ticket,
      clientId: randomUUID(),
      data: { session: s.id, epoch: s.epoch, state: s.state, ...(note ? { note: note.slice(0, 2000) } : {}) },
    })
  }

  take(ticket: string, session: string, force = false): Promise<{ epoch: number } | { heldBy: string }> {
    return this.#client.take(ticket, session, force)
  }
  renew(ticket: string, epoch: number): Promise<boolean> {
    return this.#client.renew(ticket, epoch)
  }
  async release(ticket: string, epoch: number): Promise<void> {
    await this.#client.release(ticket, epoch)
  }
  async mode(repo: string): Promise<RepoMode> {
    return this.#local.board.repos.get(repo)?.mode ?? 'branch'
  }
  async setMode(repo: string, mode: RepoMode): Promise<void> {
    await this.#client.setMode(repo, mode)
  }
  propose(p: Proposal): Promise<Proposed> {
    return this.#client.propose(p)
  }
  async pull(s: Session): Promise<Pull | null> {
    const pull = this.#local.board.cards.get(s.ticket)?.pull ?? null
    return pull?.number === s.pull?.number ? pull : null
  }
}
