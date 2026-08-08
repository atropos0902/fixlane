import {
  type Draft,
  type Lease,
  type LogEntry,
  LogEntry as LogEntrySchema,
  NO_LEASE,
  type Pull,
  type Repo,
  type ServerNote,
} from '@fixlane/core'
import pg from 'pg'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (name text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS tickets (
  id text PRIMARY KEY,
  repo text NOT NULL,
  lease jsonb NOT NULL,
  pull jsonb
);
CREATE TABLE IF NOT EXISTS entries (
  seq bigint PRIMARY KEY,
  client_id text UNIQUE,
  data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS counter (one boolean PRIMARY KEY DEFAULT true CHECK (one), seq bigint NOT NULL);
INSERT INTO counter VALUES (true, 0) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS deliveries (host text NOT NULL, id text NOT NULL, PRIMARY KEY (host, id));
`

export type Tx = pg.PoolClient

export interface TicketRow {
  id: string
  repo: string
  lease: Lease
  pull: Pull | null
}

export class Db {
  readonly pool: pg.Pool
  readonly url: string
  constructor(url: string) {
    this.url = url
    this.pool = new pg.Pool({ connectionString: url, max: 20 })
    this.pool.on('error', () => {}) // an idle connection that died. The next query opens another.
  }

  async init(): Promise<void> {
    await this.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock(7001)')
      await t.query(SCHEMA)
    })
  }

  async close(): Promise<void> {
    await this.pool.end()
  }

  async tx<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect()
    let broken: Error | undefined
    try {
      await c.query('BEGIN')
      const r = await fn(c)
      await c.query('COMMIT')
      return r
    } catch (e) {
      await c.query('ROLLBACK').catch((x: Error) => {
        broken = x
      })
      throw e
    } finally {
      c.release(broken)
    }
  }

  /**
   * Numbers come from one locked row and not from a sequence. A sequence hands out 7 and 8 and may commit
   * 8 first, and a reader who then asks for "everything after 8" never sees 7.
   */
  async append(t: Tx, actor: string, e: Draft | ServerNote): Promise<number> {
    const { rows } = await t.query<{ seq: string }>('UPDATE counter SET seq = seq + 1 RETURNING seq')
    const seq = Number(rows[0]!.seq)
    const clientId = 'clientId' in e ? e.clientId : null
    await t.query('INSERT INTO entries (seq, client_id, data) VALUES ($1, $2, $3)', [
      seq,
      clientId,
      { ...e, seq, actor },
    ])
    await t.query("SELECT pg_notify('entries', $1)", [String(seq)])
    return seq
  }

  async known(t: Tx, clientId: string): Promise<number | null> {
    const { rows } = await t.query<{ seq: string }>('SELECT seq FROM entries WHERE client_id = $1', [
      clientId,
    ])
    return rows[0] ? Number(rows[0].seq) : null
  }

  async after(seq: number, limit = 500): Promise<LogEntry[]> {
    const { rows } = await this.pool.query<{ data: unknown }>(
      'SELECT data FROM entries WHERE seq > $1 ORDER BY seq LIMIT $2',
      [seq, limit],
    )
    return rows.map((r) => LogEntrySchema.parse(r.data))
  }

  async ticket(t: Tx, id: string): Promise<TicketRow | null> {
    const { rows } = await t.query<TicketRow>(
      'SELECT id, repo, lease, pull FROM tickets WHERE id = $1 FOR UPDATE',
      [id],
    )
    return rows[0] ?? null
  }
  async addTicket(t: Tx, id: string, repo: string): Promise<boolean> {
    const r = await t.query(
      'INSERT INTO tickets (id, repo, lease) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [id, repo, NO_LEASE],
    )
    return r.rowCount === 1
  }
  async setLease(t: Tx, id: string, l: Lease): Promise<void> {
    await t.query('UPDATE tickets SET lease = $2 WHERE id = $1', [id, l])
  }
  async setPull(t: Tx, id: string, p: Pull): Promise<void> {
    await t.query('UPDATE tickets SET pull = $2 WHERE id = $1', [id, p])
  }

  async repo(t: Tx | pg.Pool, name: string): Promise<Repo | null> {
    const { rows } = await t.query<{ data: Repo }>('SELECT data FROM repos WHERE name = $1', [name])
    return rows[0]?.data ?? null
  }
  async repoByProject(project: string, host: string): Promise<Repo | null> {
    const { rows } = await this.pool.query<{ data: Repo }>(
      "SELECT data FROM repos WHERE data->>'project' = $1 AND data->>'host' = $2",
      [project, host],
    )
    return rows[0]?.data ?? null
  }
  async putRepo(t: Tx, r: Repo): Promise<void> {
    await t.query('INSERT INTO repos VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET data = $2', [r.name, r])
  }
}
