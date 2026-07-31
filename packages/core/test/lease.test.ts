import { describe, expect, test } from 'vitest'
import {
  branchName,
  LEASE_MS,
  type Lease,
  NO_LEASE,
  parseBranch,
  release,
  renew,
  take,
} from '../src/lease.ts'

const now = 1_000_000
const got = (l: Lease, holder = 'a', session = 's1', at = now, force = false): Lease => {
  const r = take(l, holder, session, at, force)
  if (!r.ok) throw new Error(`held by ${r.holder}`)
  return r.lease
}

describe('take', () => {
  test('the first one gets epoch 1', () => {
    expect(take(NO_LEASE, 'a', 's1', now)).toEqual({
      ok: true,
      fresh: true,
      lease: { epoch: 1, holder: 'a', session: 's1', until: now + LEASE_MS },
    })
  })

  test('the same holder and session get the same epoch, with more time', () => {
    const r = take(got(NO_LEASE), 'a', 's1', now + 10)
    expect(r).toEqual({
      ok: true,
      fresh: false,
      lease: { epoch: 1, holder: 'a', session: 's1', until: now + 10 + LEASE_MS },
    })
  })

  test('nobody else gets it while it is live, not even the same desktop for another session', () => {
    expect(take(got(NO_LEASE), 'b', 's2', now)).toEqual({ ok: false, holder: 'a' })
    expect(take(got(NO_LEASE), 'a', 's2', now)).toEqual({ ok: false, holder: 'a' })
    expect(take(got(NO_LEASE), 'b', 's1', now)).toEqual({ ok: false, holder: 'a' })
  })

  test('it ends exactly at its time', () => {
    const l = got(NO_LEASE)
    expect(take(l, 'b', 's2', l.until - 1).ok).toBe(false)
    expect(got(l, 'b', 's2', l.until).epoch).toBe(2)
  })

  test('taking again after it lapsed is a new epoch, also for the old holder', () => {
    const l = got(NO_LEASE)
    expect(got(l, 'a', 's1', l.until).epoch).toBe(2)
  })

  test('a person can force it', () => {
    expect(got(got(NO_LEASE), 'b', 's2', now, true)).toMatchObject({ epoch: 2, holder: 'b' })
  })

  test('forcing does not give a holder a new epoch for what it already has', () => {
    expect(got(got(NO_LEASE), 'a', 's1', now, true).epoch).toBe(1)
  })
})

test('renew works after a sleep if nobody took it, and not after someone did', () => {
  const l = got(NO_LEASE)
  expect(renew(l, 1, l.until + 5)).toEqual({ ...l, until: l.until + 5 + LEASE_MS })
  expect(renew(got(l, 'b', 's2', l.until), 1, l.until)).toBeNull()
  expect(renew(NO_LEASE, 0, now)).toBeNull()
})

test('release frees it and keeps the epoch', () => {
  const l = got(NO_LEASE)
  expect(release(l, 1)).toEqual({ epoch: 1, holder: null, session: null, until: 0 })
  expect(release(l, 2)).toBeNull()
  expect(release(NO_LEASE, 0)).toBeNull()
})

test('branch names carry the epoch and read back', () => {
  expect(branchName('sec-12', 4)).toBe('fix/sec-12/4')
  expect(parseBranch('fix/sec-12/4')).toEqual({ ticket: 'sec-12', epoch: 4 })
  for (const bad of [
    'fix/sec-12/0',
    'fix/sec-12/',
    'fix/a/b/1',
    'xfix/a/1',
    'fix/a/1x',
    'fix/A/1',
    'fix/-a/1',
  ]) {
    expect(parseBranch(bad)).toBeNull()
  }
})
