import {
  branchName,
  type Draft,
  type Proposal,
  type Proposed,
  type Pull,
  parseBranch,
  type Repo,
  type RepoMode,
  release,
  renew,
  take,
} from '@fixlane/core'
import type { GitHost, Hook } from '@fixlane/hosts'
import type { Db, Tx } from './db.ts'

export class Refused extends Error {}

/** Everything the server decides. It knows nothing about HTTP. */
export class Service {
  readonly db: Db
  readonly #hosts: Partial<Record<string, GitHost>>
  readonly #now: () => number

  constructor(db: Db, hosts: Partial<Record<string, GitHost>>, now: () => number = Date.now) {
    this.db = db
    this.#hosts = hosts
    this.#now = now
  }

  host(kind: string): GitHost {
    const h = this.#hosts[kind]
    if (!h) throw new Refused(`no ${kind} here`)
    return h
  }

  async #need(t: Tx, id: string) {
    const row = await this.db.ticket(t, id)
    if (!row) throw new Refused(`no ticket ${id}`)
    return row
  }

  addRepo(actor: string, r: Repo): Promise<void> {
    return this.db.tx(async (t) => {
      const old = await this.db.repo(t, r.name)
      if (old) return
      await this.db.putRepo(t, r)
      await this.db.append(t, actor, { type: 'repo.added', ticket: null, data: r })
    })
  }

  setMode(actor: string, repo: string, mode: RepoMode): Promise<void> {
    return this.db.tx(async (t) => {
      const r = await this.db.repo(t, repo)
      if (!r) throw new Refused(`no repository ${repo}`)
      await this.db.putRepo(t, { ...r, mode })
      await this.db.append(t, actor, { type: 'repo.mode', ticket: null, data: { repo, mode } })
    })
  }

  /** A desktop that was offline sends its drafts again, so one that is already in gives back its number. */
  append(actor: string, d: Draft): Promise<number> {
    return this.db.tx(async (t) => {
      if (d.type === 'ticket.filed') {
        if (d.data.id !== d.ticket) throw new Refused('the ticket and its id differ')
        const fresh = await this.db.addTicket(t, d.ticket, d.data.repo)
        if (!fresh) {
          const at = await this.db.known(t, d.clientId)
          if (at !== null) return at
          throw new Refused(`ticket ${d.ticket} exists`)
        }
      }
      const row = await this.#need(t, d.ticket)
      const at = await this.db.known(t, d.clientId)
      if (at !== null) return at
      if (d.type === 'session.moved' && d.data.epoch !== row.lease.epoch) {
        throw new Refused(`epoch ${d.data.epoch} is over`)
      }
      return this.db.append(t, actor, d)
    })
  }

  take(
    holder: string,
    ticket: string,
    session: string,
    force: boolean,
  ): Promise<{ epoch: number } | { heldBy: string }> {
    return this.db.tx(async (t) => {
      const row = await this.#need(t, ticket)
      if (row.pull && row.pull.state !== 'closed') return { heldBy: `pull request ${row.pull.number}` }
      const r = take(row.lease, holder, session, this.#now(), force)
      if (!r.ok) return { heldBy: r.holder }
      await this.db.setLease(t, ticket, r.lease)
      if (r.fresh) {
        const data = { holder, session, epoch: r.lease.epoch }
        await this.db.append(t, holder, { type: 'lease.taken', ticket, data })
      }
      return { epoch: r.lease.epoch }
    })
  }

  renew(ticket: string, epoch: number): Promise<boolean> {
    return this.db.tx(async (t) => {
      const l = renew((await this.#need(t, ticket)).lease, epoch, this.#now())
      if (l) await this.db.setLease(t, ticket, l)
      return l !== null
    })
  }

  release(holder: string, ticket: string, epoch: number): Promise<void> {
    return this.db.tx(async (t) => {
      const l = release((await this.#need(t, ticket)).lease, epoch)
      if (!l) return
      await this.db.setLease(t, ticket, l)
      await this.db.append(t, holder, { type: 'lease.released', ticket, data: { epoch } })
    })
  }

  /**
   * The only place a pull request is opened. The ticket's row stays locked meanwhile, so the epoch that
   * was checked is still the current one when the host answers.
   */
  propose(actor: string, p: Proposal): Promise<Proposed> {
    return this.db.tx(async (t) => {
      const row = await this.#need(t, p.ticket)
      if (row.lease.epoch !== p.epoch || p.head !== branchName(p.ticket, p.epoch)) return { kind: 'stale' }
      const repo = await this.db.repo(t, row.repo)
      if (!repo || p.repo !== row.repo) throw new Refused(`no repository ${p.repo}`)
      if (row.pull && row.pull.head === p.head) return { kind: 'opened', pull: row.pull }
      if (repo.mode === 'branch') return { kind: 'branch-only' }

      const host = this.host(repo.host)
      // Opened by an earlier epoch while that was current, by a server that died before writing it down.
      for (let e = p.epoch - 1; e >= 1; e--) {
        const old = await host.findPull(repo.project, branchName(p.ticket, e))
        if (old && old.state !== 'closed') return this.#record(t, actor, p.ticket, e, old)
      }
      const at = await host.headSha(repo.project, p.head)
      if (at !== p.sha) throw new Refused(`${p.head} is at ${at} on the host`)
      const pull = await host.openPull(repo.project, {
        head: p.head,
        base: repo.base,
        title: p.title,
        body: p.body,
      })
      return this.#record(t, actor, p.ticket, p.epoch, pull)
    })
  }

  async #record(t: Tx, actor: string, ticket: string, epoch: number, pull: Pull): Promise<Proposed> {
    await this.db.setPull(t, ticket, pull)
    await this.db.append(t, actor, { type: 'pull.opened', ticket, data: { ...pull, epoch } })
    return { kind: 'opened', pull }
  }

  /**
   * A webhook only says where to look. What it claims is not used, so one that comes twice, late or in the
   * wrong order does no harm.
   */
  async hook(kind: string, h: Hook): Promise<void> {
    const seen = await this.db.pool.query('INSERT INTO deliveries VALUES ($1, $2) ON CONFLICT DO NOTHING', [
      kind,
      h.delivery,
    ])
    if (h.delivery !== '' && seen.rowCount === 0) return
    try {
      const repo = await this.db.repoByProject(h.project, kind)
      const pull = repo ? await this.host(kind).getPull(h.project, h.number) : null
      const at = pull ? parseBranch(pull.head) : null
      if (pull && at) await this.refresh(at.ticket, pull)
    } catch (e) {
      // The host sends it again, and that must not look like something we have seen.
      await this.db.pool.query('DELETE FROM deliveries WHERE host = $1 AND id = $2', [kind, h.delivery])
      throw e
    }
  }

  refresh(ticket: string, pull: Pull): Promise<void> {
    return this.db.tx(async (t) => {
      const row = await this.db.ticket(t, ticket)
      if (!row?.pull || row.pull.number !== pull.number) return
      if (row.pull.state === pull.state || row.pull.state === 'merged') return
      await this.db.setPull(t, ticket, pull)
      await this.db.append(t, 'git host', { type: 'pull.changed', ticket, data: pull })
    })
  }
}
