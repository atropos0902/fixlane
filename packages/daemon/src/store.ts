import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  advance,
  type Happening,
  isOver,
  type Progress,
  type Pull,
  type Repo,
  type RunnerLine,
  type SessionState,
  START,
  type Ticket,
} from '@fixlane/core'
import Database from 'better-sqlite3'

export type Runtime = 'claude' | 'codex' | 'replay'

export interface Session extends Progress {
  id: string
  ticket: string
  repo: string
  runtime: Runtime
  base: string | null
  head: string | null
  paused: boolean
  note: string | null
  tokensIn: number
  tokensOut: number
  costMicros: number
}

export interface Verdict {
  ok: boolean
  why: string
  retry: boolean
  proof: string[]
  runs: { label: string; results: { name: string; outcome: string }[] }[]
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS repos (name TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, ticket TEXT NOT NULL, repo TEXT NOT NULL, runtime TEXT NOT NULL,
  state TEXT NOT NULL, attempt INTEGER NOT NULL, epoch INTEGER, reason TEXT, feedback TEXT, pull TEXT, outcome TEXT,
  base TEXT, head TEXT, paused INTEGER NOT NULL DEFAULT 0, note TEXT,
  tokensIn INTEGER NOT NULL DEFAULT 0, tokensOut INTEGER NOT NULL DEFAULT 0, costMicros INTEGER NOT NULL DEFAULT 0
);
-- A ticket is worked by one session at a time on this machine.
CREATE UNIQUE INDEX IF NOT EXISTS one_open ON sessions(ticket) WHERE state NOT IN ('done', 'stopped');
CREATE TABLE IF NOT EXISTS moves (n INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, was TEXT NOT NULL, now TEXT NOT NULL, happening TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS log (session TEXT NOT NULL, attempt INTEGER NOT NULL, n INTEGER NOT NULL, line TEXT NOT NULL, PRIMARY KEY (session, attempt, n));
CREATE TABLE IF NOT EXISTS verdicts (session TEXT NOT NULL, attempt INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (session, attempt));
CREATE TABLE IF NOT EXISTS replays (ticket TEXT PRIMARY KEY, steps TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS leases (ticket TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries (seq INTEGER PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outbox (n INTEGER PRIMARY KEY AUTOINCREMENT, clientId TEXT UNIQUE NOT NULL, draft TEXT NOT NULL);
`

interface Row extends Omit<Session, 'pull' | 'paused'> {
  pull: string | null
  paused: number
}

export interface StoreEvents {
  session: [Session]
  line: [{ session: string; attempt: number; n: number; line: RunnerLine }]
  board: []
}

/** Everything the daemon has to remember. A move is on disk before anything is done about it. */
export class Store extends EventEmitter<StoreEvents> {
  readonly db: Database.Database
  readonly fault: (point: string) => void

  constructor(path: string, fault: (point: string) => void = () => {}) {
    super()
    this.setMaxListeners(0) // one per waiting session
    this.fault = fault
    this.db = new Database(path)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.exec(SCHEMA)
  }

  close(): void {
    this.db.close()
  }

  #row(r: Row | undefined): Session | null {
    if (!r) return null
    return { ...r, pull: r.pull ? (JSON.parse(r.pull) as Pull) : null, paused: r.paused === 1 }
  }

  putTicket(t: Ticket): void {
    this.db.prepare('INSERT OR REPLACE INTO tickets VALUES (?, ?)').run(t.id, JSON.stringify(t))
    this.emit('board')
  }
  ticket(id: string): Ticket | null {
    const r = this.db.prepare('SELECT data FROM tickets WHERE id = ?').get(id) as { data: string } | undefined
    return r ? (JSON.parse(r.data) as Ticket) : null
  }
  tickets(): Ticket[] {
    const rows = this.db.prepare('SELECT data FROM tickets ORDER BY id').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Ticket)
  }

  putRepo(r: Repo): void {
    this.db.prepare('INSERT OR REPLACE INTO repos VALUES (?, ?)').run(r.name, JSON.stringify(r))
    this.emit('board')
  }
  repo(name: string): Repo | null {
    const r = this.db.prepare('SELECT data FROM repos WHERE name = ?').get(name) as
      | { data: string }
      | undefined
    return r ? (JSON.parse(r.data) as Repo) : null
  }
  repos(): Repo[] {
    const rows = this.db.prepare('SELECT data FROM repos ORDER BY name').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Repo)
  }

  putReplay(ticket: string, steps: unknown[]): void {
    this.db.prepare('INSERT OR REPLACE INTO replays VALUES (?, ?)').run(ticket, JSON.stringify(steps))
  }
  replay(ticket: string): string | null {
    const r = this.db.prepare('SELECT steps FROM replays WHERE ticket = ?').get(ticket) as
      | { steps: string }
      | undefined
    return r?.steps ?? null
  }

  newSession(ticket: Ticket, runtime: Runtime): Session {
    const id = randomBytes(5).toString('hex')
    this.db
      .prepare('INSERT INTO sessions (id, ticket, repo, runtime, state, attempt) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ticket.id, ticket.repo, runtime, START.state, START.attempt)
    const s = this.session(id)!
    this.emit('session', s)
    return s
  }

  session(id: string): Session | null {
    return this.#row(this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined)
  }
  sessions(): Session[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY rowid').all() as Row[]
    return rows.map((r) => this.#row(r)!)
  }
  open(): Session[] {
    return this.sessions().filter((s) => !isOver(s.state))
  }

  /** Moves a session on, in one transaction. Nothing else changes a session's state. */
  move(id: string, h: Happening, extra: Partial<Pick<Session, 'base' | 'head'>> = {}): Session {
    let was: SessionState = 'queued'
    const next = this.db.transaction(() => {
      const s = this.session(id)
      if (!s) throw new Error(`no session ${id}`)
      was = s.state
      const p = advance(s, h)
      this.fault(`before:${was}>${p.state}`)
      this.db
        .prepare(
          `UPDATE sessions SET state = ?, attempt = ?, epoch = ?, reason = ?, feedback = ?, pull = ?, outcome = ?,
             base = coalesce(?, base), head = coalesce(?, head), note = NULL WHERE id = ?`,
        )
        .run(
          p.state,
          p.attempt,
          p.epoch,
          p.reason,
          p.feedback,
          p.pull ? JSON.stringify(p.pull) : null,
          p.outcome,
          extra.base ?? null,
          extra.head ?? null,
          id,
        )
      this.db
        .prepare('INSERT INTO moves (session, was, now, happening) VALUES (?, ?, ?, ?)')
        .run(id, was, p.state, JSON.stringify(h))
      return this.session(id)!
    })()
    this.fault(`after:${was}>${next.state}`)
    this.emit('session', next)
    return next
  }

  set(id: string, f: Partial<Pick<Session, 'base' | 'head' | 'paused' | 'note'>>): void {
    for (const [k, v] of Object.entries(f)) {
      if (!['base', 'head', 'paused', 'note'].includes(k)) continue
      this.db
        .prepare(`UPDATE sessions SET ${k} = ? WHERE id = ?`)
        .run(typeof v === 'boolean' ? Number(v) : v, id)
    }
    this.emit('session', this.session(id)!)
  }

  spend(id: string, tokensIn: number, tokensOut: number, costMicros: number): void {
    this.db
      .prepare(
        'UPDATE sessions SET tokensIn = tokensIn + ?, tokensOut = tokensOut + ?, costMicros = costMicros + ? WHERE id = ?',
      )
      .run(tokensIn, tokensOut, costMicros, id)
    this.emit('session', this.session(id)!)
  }

  moves(id: string): { was: string; now: string; happening: Happening }[] {
    const rows = this.db
      .prepare('SELECT was, now, happening FROM moves WHERE session = ? ORDER BY n')
      .all(id) as {
      was: string
      now: string
      happening: string
    }[]
    return rows.map((r) => ({ ...r, happening: JSON.parse(r.happening) as Happening }))
  }

  /** Following a container from its first line again writes the same rows again, so this ignores them. */
  addLine(session: string, attempt: number, n: number, line: RunnerLine): void {
    const r = this.db
      .prepare('INSERT OR IGNORE INTO log VALUES (?, ?, ?, ?)')
      .run(session, attempt, n, JSON.stringify(line))
    if (r.changes > 0) this.emit('line', { session, attempt, n, line })
  }
  lines(session: string): { attempt: number; n: number; line: RunnerLine }[] {
    const rows = this.db
      .prepare('SELECT attempt, n, line FROM log WHERE session = ? ORDER BY attempt, n')
      .all(session) as {
      attempt: number
      n: number
      line: string
    }[]
    return rows.map((r) => ({ ...r, line: JSON.parse(r.line) as RunnerLine }))
  }

  putVerdict(session: string, attempt: number, v: Verdict): void {
    this.db
      .prepare('INSERT OR REPLACE INTO verdicts VALUES (?, ?, ?)')
      .run(session, attempt, JSON.stringify(v))
  }
  verdict(session: string): Verdict | null {
    const r = this.db
      .prepare('SELECT data FROM verdicts WHERE session = ? ORDER BY attempt DESC')
      .get(session) as { data: string } | undefined
    return r ? (JSON.parse(r.data) as Verdict) : null
  }
}
