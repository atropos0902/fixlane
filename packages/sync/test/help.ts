import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Draft, type LogEntry, Repo, Ticket } from '@fixlane/core'
import { FakeHost } from '@fixlane/fakes'
import { GitHub } from '@fixlane/hosts'
import pg from 'pg'
import { Db, type Local, Service } from '../src/index.ts'

export const PG = process.env.FIXLANE_PG ?? 'postgres://fixlane:fixlane@127.0.0.1:55432/fixlane'

/** A database of its own for each test. */
export async function freshDb(): Promise<Db> {
  const name = `t_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Client({ connectionString: PG })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(PG)
  url.pathname = `/${name}`
  const db = new Db(url.toString())
  await db.init()
  return db
}

export class Hosted {
  readonly root = mkdtempSync(join(tmpdir(), 'fixlane-sync-'))
  fake!: FakeHost
  async start(): Promise<this> {
    writeFileSync(join(this.root, 'f'), 'x')
    this.fake = await new FakeHost(join(this.root, 'repos')).listen()
    this.fake.create('acme/depot', this.root)
    return this
  }
  gh(): GitHub {
    const pace = { tries: 4, now: Date.now, sleep: async () => {} }
    return new GitHub({
      url: this.fake.githubApi,
      token: this.fake.token,
      hookSecret: this.fake.hookSecret,
      pace,
    })
  }
  /** What a desktop's push does. Pushing is never fenced: a stale machine can do this too. */
  push(branch: string): string {
    execFileSync('git', [
      '-C',
      this.fake.dir('acme/depot'),
      'update-ref',
      `refs/heads/${branch}`,
      'refs/heads/main',
    ])
    return this.fake.sha('acme/depot', branch)!
  }
  stop(): void {
    this.fake.close()
    rmSync(this.root, { recursive: true, force: true })
  }
}

export const repo = Repo.parse({ name: 'depot', host: 'github', project: 'acme/depot', mode: 'pr' })
export const ticketOf = (id: string): Ticket =>
  Ticket.parse({ id, repo: 'depot', kind: 'code', title: id, body: '' })
export const cid = (): string => randomUUID()
export const filed = (id: string): Draft => ({
  type: 'ticket.filed',
  ticket: id,
  clientId: cid(),
  data: ticketOf(id),
})
export const said = (id: string, text: string): Draft => ({
  type: 'ticket.commented',
  ticket: id,
  clientId: cid(),
  data: { text },
})

export async function ready(s: Service, ...ids: string[]): Promise<void> {
  await s.addRepo('sam', repo)
  for (const id of ids) await s.append('sam', filed(id))
}

export class Memory implements Local {
  entries: LogEntry[] = []
  out: Draft[] = []
  cursor(): number {
    return this.entries.at(-1)?.seq ?? 0
  }
  add(es: LogEntry[]): void {
    for (const e of es) if (e.seq > this.cursor()) this.entries.push(e)
  }
  queue(d: Draft): void {
    this.out.push(d)
  }
  queued(): Draft[] {
    return this.out
  }
  unqueue(id: string): void {
    this.out = this.out.filter((d) => d.clientId !== id)
  }
}

/** Small and seedable, so that a failing schedule can be run again. */
export const random = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export { Service }
