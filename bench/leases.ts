// Random schedules of machines that sleep, wake, take over, push and propose, some of it at the same time.
// Each pull request that gets opened is checked against the lease at that moment.
// usage: node bench/leases.ts [schedules]
import { writeFileSync } from 'node:fs'
import { branchName, LEASE_MS, type Lease, parseBranch } from '@fixlane/core'
import type { GitHost, NewPull } from '@fixlane/hosts'
import { freshDb, Hosted, random, ready, Service } from '../packages/sync/test/help.ts'

const schedules = Number(process.argv[2] ?? 1000)
const db = await freshDb()
const h = await new Hosted().start()
let now = 1_000_000
const wrong: string[] = []
let crashed = 0

/** Looks, on another connection, at which epoch holds the ticket when a pull request is opened. */
const watch = (g: GitHost, dies: () => boolean): GitHost =>
  new Proxy(g, {
    get(target, key) {
      if (key !== 'openPull') {
        const v = Reflect.get(target, key) as unknown
        return typeof v === 'function' ? v.bind(target) : v
      }
      return async (project: string, p: NewPull) => {
        const at = parseBranch(p.head)!
        const { rows } = await db.pool.query<{ lease: Lease }>('SELECT lease FROM tickets WHERE id = $1', [
          at.ticket,
        ])
        if (rows[0]!.lease.epoch !== at.epoch) wrong.push(`${p.head} opened at epoch ${rows[0]!.lease.epoch}`)
        const pull = await target.openPull(project, p)
        if (dies()) {
          crashed++
          throw new Error('the server died here')
        }
        return pull
      }
    },
  })

const tally = { opened: 0, stale: 0, refused: 0, pushesByStale: 0, takeovers: 0 }
for (let i = 0; i < schedules; i++) {
  const rnd = random(i + 1)
  const id = `t-${i}`
  const service = new Service(db, { github: watch(h.gh(), () => rnd() < 0.15) }, () => now)
  await ready(service, id)
  const machines = Array.from({ length: 3 }, (_, n) => ({ name: `m${n}`, epoch: 0, session: 0, sha: '' }))

  const act = async (m: (typeof machines)[number]): Promise<void> => {
    const r = rnd()
    try {
      if (r < 0.3 || m.epoch === 0) {
        if (rnd() < 0.5) m.session++
        const t = await service.take(m.name, id, `${m.name}-${m.session}`, rnd() < 0.2)
        if ('epoch' in t) {
          if (t.epoch !== m.epoch) tally.takeovers++
          m.epoch = t.epoch
        }
      } else if (r < 0.45) {
        // Most machines notice that they lost it. This one may not look.
        const ok = await service.renew(id, m.epoch)
        if (!ok && rnd() < 0.5) m.epoch = 0
      } else if (r < 0.7) {
        const { rows } = await db.pool.query<{ lease: Lease }>('SELECT lease FROM tickets WHERE id = $1', [
          id,
        ])
        if (rows[0]!.lease.epoch !== m.epoch) tally.pushesByStale++
        m.sha = h.push(branchName(id, m.epoch))
      } else if (r < 0.75) {
        await service.release(m.name, id, m.epoch)
      } else if (m.sha) {
        const p = await service.propose(m.name, {
          ticket: id,
          repo: 'depot',
          epoch: m.epoch,
          head: branchName(id, m.epoch),
          sha: m.sha,
          title: 'T',
          body: '',
        })
        if (p.kind === 'opened') tally.opened++
        if (p.kind === 'stale') tally.stale++
      }
    } catch {
      tally.refused++
    }
  }
  for (let step = 0; step < 25; step++) {
    if (rnd() < 0.4) now += Math.floor(rnd() * 3 * LEASE_MS) // everybody's laptop lid
    const n = rnd() < 0.4 ? 2 : 1
    await Promise.all(Array.from({ length: n }, () => act(machines[Math.floor(rnd() * 3)]!)))
  }
  const pulls = h.fake.pulls.filter((p) => p.head.startsWith(`fix/${id}/`))
  if (pulls.length > 1) wrong.push(`${id} has ${pulls.length} pull requests`)
  if (i % 100 === 99) process.stderr.write(`\r${i + 1}`)
}
const result = { schedules, pulls: h.fake.pulls.length, ...tally, serverDeathsAfterOpening: crashed, wrong }
writeFileSync(new URL('results/leases.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
console.log(result)
await db.close()
h.stop()
process.exit(wrong.length > 0 ? 1 : 0)
