import { LEASE_MS } from '@fixlane/core'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Db } from '../src/index.ts'
import { filed, freshDb, Hosted, ready, Service, said } from './help.ts'

let db: Db
let h: Hosted
let now = 1_000_000
let s: Service

beforeEach(async () => {
  db = await freshDb()
  h = await new Hosted().start()
  now = 1_000_000
  s = new Service(db, { github: h.gh() }, () => now)
})
afterEach(async () => {
  await db.close()
  h.stop()
})

const took = async (who: string, session: string, force = false): Promise<number> => {
  const r = await s.take(who, 'sec-1', session, force)
  if ('heldBy' in r) throw new Error(`held by ${r.heldBy}`)
  return r.epoch
}
const propose = (epoch: number, sha = h.push(`fix/sec-1/${epoch}`)) =>
  s.propose('sam', {
    ticket: 'sec-1',
    repo: 'depot',
    epoch,
    head: `fix/sec-1/${epoch}`,
    sha,
    title: 'T',
    body: '',
  })

describe('the log', () => {
  test('has no gaps and no reader misses an entry, with many writers at once', async () => {
    await ready(s, 'sec-1')
    const seen: number[] = []
    let stop = false
    const reader = (async () => {
      while (!stop || (await db.after(seen.at(-1) ?? 0)).length > 0) {
        for (const e of await db.after(seen.at(-1) ?? 0)) seen.push(e.seq)
      }
    })()
    await Promise.all(Array.from({ length: 200 }, (_, i) => s.append('sam', said('sec-1', `c${i}`))))
    stop = true
    await reader
    expect(seen).toEqual(Array.from({ length: 202 }, (_, i) => i + 1))
  })

  test('takes a draft once, however often it is sent', async () => {
    await ready(s, 'sec-1')
    const d = said('sec-1', 'hi')
    const [a, b] = [await s.append('sam', d), await s.append('sam', d)]
    expect(a).toBe(b)
    const f = filed('sec-2')
    expect(await s.append('sam', f)).toBe(await s.append('sam', f))
  })

  test('refuses a second ticket with the same id, and entries for tickets that do not exist', async () => {
    await ready(s, 'sec-1')
    await expect(s.append('kim', filed('sec-1'))).rejects.toThrow('exists')
    await expect(s.append('kim', said('nope', 'x'))).rejects.toThrow('no ticket')
  })

  test('refuses moves of an old epoch', async () => {
    await ready(s, 'sec-1')
    const e = await took('sam', 's1')
    const moved = (epoch: number) =>
      s.append('sam', {
        type: 'session.moved',
        ticket: 'sec-1',
        clientId: `client-${epoch}-${Math.random()}`,
        data: { session: 's1', epoch, state: 'running' },
      })
    await moved(e)
    await took('kim', 's2', true)
    await expect(moved(e)).rejects.toThrow('epoch 1 is over')
  })
})

describe('leases', () => {
  test('two desktops at once: one gets it', async () => {
    await ready(s, 'sec-1')
    const r = await Promise.all(
      Array.from({ length: 10 }, (_, i) => s.take(`d${i}`, 'sec-1', `s${i}`, false)),
    )
    expect(r.filter((x) => 'epoch' in x)).toEqual([{ epoch: 1 }])
  })

  test('asking twice after a crash gives the same epoch', async () => {
    await ready(s, 'sec-1')
    expect(await took('sam', 's1')).toBe(await took('sam', 's1'))
  })

  test('a machine that slept can renew until somebody takes over', async () => {
    await ready(s, 'sec-1')
    const e = await took('sam', 's1')
    now += 10 * LEASE_MS
    expect(await s.renew('sec-1', e)).toBe(true)
    now += 10 * LEASE_MS
    await took('kim', 's2')
    expect(await s.renew('sec-1', e)).toBe(false)
  })

  test('a ticket with an open pull request cannot be taken, one that was closed can', async () => {
    await ready(s, 'sec-1')
    const e = await took('sam', 's1')
    await propose(e)
    expect(await s.take('kim', 'sec-1', 's2', true)).toEqual({ heldBy: 'pull request 1' })
    h.fake.settle('acme/depot', 1, 'closed')
    const { headers, body } = h.fake.hook('github', h.fake.pulls[0]!)
    await s.hook('github', h.gh().readHook(headers, body)!)
    now += LEASE_MS
    expect(await took('kim', 's2')).toBe(e + 1)
  })
})

describe('pull requests', () => {
  test('are opened for the current epoch only', async () => {
    await ready(s, 'sec-1')
    const e = await took('sam', 's1')
    now += LEASE_MS
    await took('kim', 's2')
    expect(await propose(e)).toEqual({ kind: 'stale' })
    expect(h.fake.pulls).toEqual([])
    expect(await propose(2)).toMatchObject({ kind: 'opened', pull: { head: 'fix/sec-1/2' } })
  })

  test('cannot be opened for a branch of another epoch or ticket', async () => {
    await ready(s, 'sec-1')
    await took('sam', 's1')
    const p = { ticket: 'sec-1', repo: 'depot', epoch: 1, sha: h.push('fix/sec-1/7'), title: 'T', body: '' }
    expect(await s.propose('sam', { ...p, head: 'fix/sec-1/7' })).toEqual({ kind: 'stale' })
    expect(await s.propose('sam', { ...p, head: 'fix/other/1' })).toEqual({ kind: 'stale' })
  })

  test('need the branch on the host to be what was checked', async () => {
    await ready(s, 'sec-1')
    const e = await took('sam', 's1')
    h.push('fix/sec-1/1')
    await expect(propose(e, 'a'.repeat(40))).rejects.toThrow('is at')
    expect(h.fake.pulls).toEqual([])
  })

  test('asked for twice, or twice at once, are one', async () => {
    await ready(s, 'sec-1')
    const e = await took('sam', 's1')
    const sha = h.push('fix/sec-1/1')
    const [a, b] = await Promise.all([propose(e, sha), propose(e, sha)])
    expect(a).toEqual(b)
    expect(await propose(e, sha)).toEqual(a)
    expect(h.fake.pulls.length).toBe(1)
  })

  test('a server that died between opening it and writing it down does not open a second one', async () => {
    await ready(s, 'sec-1')
    const e = await took('sam', 's1')
    h.push('fix/sec-1/1')
    await h.gh().openPull('acme/depot', { head: 'fix/sec-1/1', base: 'main', title: 'T', body: '' })
    now += LEASE_MS
    const e2 = await took('kim', 's2')
    expect(e2).toBe(e + 1)
    expect(await propose(e2)).toMatchObject({ kind: 'opened', pull: { number: 1, head: 'fix/sec-1/1' } })
    expect(h.fake.pulls.length).toBe(1)
  })

  test('are not opened when the repository went back to branch only', async () => {
    await ready(s, 'sec-1')
    const e = await took('sam', 's1')
    await s.setMode('kim', 'depot', 'branch')
    expect(await propose(e)).toEqual({ kind: 'branch-only' })
    expect(h.fake.pulls).toEqual([])
  })
})

describe('webhooks', () => {
  const entries = async () => (await db.after(0)).filter((e) => e.type === 'pull.changed')
  const send = async (delivery?: string) => {
    const { headers, body } = h.fake.hook('github', h.fake.pulls[0]!, delivery)
    await s.hook('github', h.gh().readHook(headers, body)!)
  }
  beforeEach(async () => {
    await ready(s, 'sec-1')
    await propose(await took('sam', 's1'))
  })

  test('twice with one id, or with two ids, change it once', async () => {
    h.fake.settle('acme/depot', 1, 'merged')
    await send('d1')
    await send('d1')
    await send('d2')
    expect((await entries()).map((e) => (e.data as { state: string }).state)).toEqual(['merged'])
  })

  test('an old one that arrives late does not undo a merge', async () => {
    const late = h.fake.hook('github', h.fake.pulls[0]!, 'early')
    h.fake.settle('acme/depot', 1, 'merged')
    await send()
    await s.hook('github', h.gh().readHook(late.headers, late.body)!)
    expect((await entries()).length).toBe(1)
  })

  test('is looked at again when the first time failed', async () => {
    h.fake.settle('acme/depot', 1, 'merged')
    h.fake.faults.push({ fault: 'error-500', method: 'GET', times: 4 })
    await expect(send('d1')).rejects.toThrow()
    await send('d1')
    expect((await entries()).length).toBe(1)
  })

  test('about other pull requests are ignored', async () => {
    await s.hook('github', { delivery: 'x', project: 'acme/depot', number: 99 })
    await s.hook('github', { delivery: 'y', project: 'who/knows', number: 1 })
    expect(await entries()).toEqual([])
  })
})
