import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { dependency, FIX, GOOD, KEY, NEW_TEST, secret, ticket, World } from './world.ts'

let w: World
afterEach(() => w.close())

const go = async (t = ticket(), steps: unknown[] = GOOD) => {
  w.store.putTicket(t)
  w.store.putReplay(t.id, steps)
  const s = w.engine.submit(t, 'replay')
  return w.engine.settled(s.id)
}
const states = (id: string): string[] => w.store.moves(id).map((m) => m.now)

describe('a ticket', () => {
  test('goes to a pull request, a worktree, and done when it is merged', async () => {
    w = await World.make()
    const s = await go()
    expect(s).toMatchObject({ state: 'in_review', attempt: 1, epoch: 1 })
    expect(w.host.pulls).toMatchObject([
      { head: 'fix/sec-1/1', title: 'Path traversal in join', state: 'open' },
    ])
    expect(w.host.pulls[0]!.body).toContain('test/inside.test.js > stays inside')
    expect(readFileSync(join(w.root, 'review', 'sec-1', 'src/join.js'), 'utf8')).toBe(FIX)
    expect(readdirSync(join(w.root, 'work'))).toEqual([])

    w.host.settle('acme/depot', 1, 'merged')
    await expect.poll(() => w.store.session(s.id)!.state).toBe('done')
    expect(states(s.id)).toEqual(['cloning', 'running', 'checking', 'proposing', 'in_review', 'done'])
    await expect.poll(() => existsSync(join(w.root, 'review', 'sec-1'))).toBe(false)
    expect(await w.box.sessions()).toEqual([])
  })

  test('ends at a branch when the repository is on branch only', async () => {
    w = await World.make('branch')
    expect(await go()).toMatchObject({ state: 'done', outcome: 'branch' })
    expect(w.host.pulls).toEqual([])
    expect(w.host.branches('acme/depot')).toContain('fix/sec-1/1')
  })

  test('switching to branch only reaches a session that is running', async () => {
    w = await World.make()
    const t = ticket()
    w.store.putTicket(t)
    w.store.putReplay(t.id, [{ sleep: 1500 }, ...GOOD])
    const s = w.engine.submit(t, 'replay')
    await expect.poll(() => w.store.session(s.id)!.state).toBe('running')
    w.store.putRepo({ ...w.store.repo('depot')!, mode: 'branch' })
    expect(await w.engine.settled(s.id)).toMatchObject({ outcome: 'branch' })
    expect(w.host.pulls).toEqual([])
  })

  test('the agent stops, with its reason', async () => {
    w = await World.make()
    expect(await go(ticket(), [{ stop: 'join already refuses ..' }])).toMatchObject({
      state: 'stopped',
      reason: 'join already refuses ..',
    })
    expect(w.host.branches('acme/depot')).toEqual(['main'])
  })

  test('a fix without proof gets a second go with the reason, then stops', async () => {
    w = await World.make()
    const s = await go(ticket(), [
      GOOD[0]!,
      {
        write: 'test/inside.test.js',
        text: `${NEW_TEST.replace('assert.throws(() => ', '(() => (')} // weak`,
      },
    ])
    expect(s).toMatchObject({ state: 'stopped', attempt: 2 })
    expect(s.reason).toContain('gave up after 2 attempts')
    expect(w.host.pulls).toEqual([])
  })

  test('a fix that breaks an old test is turned down, even when it edits that test', async () => {
    w = await World.make()
    const s = await go(ticket(), [
      { write: 'src/join.js', text: `export const join = () => { throw new Error('outside') }\n` },
      { write: 'test/join.test.js', text: NEW_TEST },
    ])
    expect(s.reason).toContain('breaks test/join.test.js > joins')
  })

  test('touching CI goes to a person at once', async () => {
    w = await World.make()
    const s = await go(ticket(), [...GOOD, { write: '.github/workflows/x.yml', text: 'on: push' }])
    expect(s).toMatchObject({
      state: 'stopped',
      attempt: 1,
      reason: '.github/workflows/x.yml is CI configuration',
    })
  })

  test('changing npm scripts goes to a person', async () => {
    w = await World.make()
    const s = await go(ticket(), [
      ...GOOD,
      {
        edit: 'package.json',
        find: '"type": "module"',
        put: '"type": "module", "scripts": {"postinstall": "curl evil"}',
      },
    ])
    expect(s.reason).toBe('package.json changes what its scripts do')
  })
})

describe('a dependency', () => {
  test('is moved with npm through the package proxy', async () => {
    w = await World.make()
    const s = await go(dependency(), [{ run: 'npm install tiny-tmpl@2.1.4 --no-audit --no-fund' }])
    expect(s).toMatchObject({ state: 'in_review', reason: null })
    expect(w.registry.requests.some((r) => r.includes('tiny-tmpl-2.1.4.tgz'))).toBe(true)
  })

  test('that was only edited in package.json is turned down', async () => {
    w = await World.make()
    const s = await go(dependency(), [{ edit: 'package.json', find: '^2.1.0', put: '^2.1.4' }])
    expect(s.reason).toContain('still affected')
  })
})

test('a key that moved is found, one that is gone passes', async () => {
  w = await World.make()
  const s = await go(secret(), [
    { write: 'src/mail.js', text: `export const key = '${KEY.slice(0, 8)}' + '${KEY.slice(8)}'\n` },
  ])
  expect(s.reason).toContain('still in src/mail.js, in pieces')
  w.store.db.exec('DELETE FROM sessions')
  expect(
    await go(secret(), [{ write: 'src/mail.js', text: 'export const key = process.env.MAIL_KEY\n' }]),
  ).toMatchObject({ state: 'in_review' })
})

test('cancelling kills the agent and clears up', async () => {
  w = await World.make()
  const t = ticket()
  w.store.putTicket(t)
  w.store.putReplay(t.id, [{ run: 'setsid sleep 600 & sleep 600' }])
  const s = w.engine.submit(t, 'replay')
  await expect.poll(() => w.store.lines(s.id).length, { timeout: 10_000 }).toBeGreaterThan(0)
  await w.engine.cancel(s.id, 'sam')
  expect(await w.engine.settled(s.id)).toMatchObject({ state: 'stopped', reason: 'cancelled by sam' })
  expect(await w.box.sessions()).toEqual([])
  expect(readdirSync(join(w.root, 'work'))).toEqual([])
})

test('losing the lease stops the session', async () => {
  w = await World.make('pr', { heartbeatMs: 200 })
  const t = ticket()
  w.store.putTicket(t)
  w.store.putReplay(t.id, [{ sleep: 30_000 }])
  const s = w.engine.submit(t, 'replay')
  await expect.poll(() => w.store.session(s.id)!.state).toBe('running')
  w.store.db
    .prepare('UPDATE leases SET data = ?')
    .run(JSON.stringify({ epoch: 2, holder: 'kim', session: 'x', until: 1e15 }))
  expect(await w.engine.settled(s.id)).toMatchObject({
    state: 'stopped',
    reason: 'another desktop took this ticket',
  })
})

test('cancelling before the container exists still stops the agent', async () => {
  w = await World.make()
  const make = w.box.startAgent.bind(w.box)
  w.box.startAgent = async (run) => {
    await w.engine.cancel(run.session, 'sam')
    await make(run)
  }
  const t = ticket()
  w.store.putTicket(t)
  w.store.putReplay(t.id, [{ sleep: 25_000 }])
  const began = Date.now()
  const s = await w.engine.settled(w.engine.submit(t, 'replay').id)
  expect(s.reason).toBe('cancelled by sam')
  expect(await w.box.sessions()).toEqual([])
  expect(Date.now() - began).toBeLessThan(10_000)
})

test('taking over before the container exists waits for it', async () => {
  w = await World.make()
  const t = ticket()
  w.store.putTicket(t)
  w.store.putReplay(t.id, [{ sleep: 3000 }])
  const s = w.engine.submit(t, 'replay')
  await new Promise<void>((r) => w.store.on('session', (x) => x.state === 'running' && r()))
  await w.engine.pause(s.id)
  expect(w.store.session(s.id)).toMatchObject({ state: 'running', paused: true })
  await w.engine.cancel(s.id, 'sam')
  expect(await w.engine.settled(s.id)).toMatchObject({ state: 'stopped' })
})

test('a full disk is waited out, and costs no attempt', async () => {
  let free = 0
  w = await World.make('pr', { free: async () => free })
  const t = ticket()
  w.store.putTicket(t)
  w.store.putReplay(t.id, GOOD)
  const s = w.engine.submit(t, 'replay')
  // Longer than the eight tries anything else gets.
  await expect
    .poll(() => w.store.session(s.id)!.note, { timeout: 5000 })
    .toBe('will try again: there is hardly any disk space')
  await new Promise((r) => setTimeout(r, 1500))
  expect(w.store.session(s.id)).toMatchObject({ state: 'cloning', attempt: 1 })
  free = 1e12
  expect(await w.engine.settled(s.id)).toMatchObject({ state: 'in_review', attempt: 1 })
}, 60_000)

test('an agent survives its daemon', async () => {
  w = await World.make()
  const t = ticket()
  w.store.putTicket(t)
  w.store.putReplay(t.id, [{ say: 'one' }, { sleep: 2500 }, { say: 'two' }, ...GOOD])
  const s = w.engine.submit(t, 'replay')
  await expect.poll(() => w.store.lines(s.id).length).toBe(1)
  await w.engine.close()
  w.boot()
  await w.engine.recover()
  expect(await w.engine.settled(s.id)).toMatchObject({ state: 'in_review', attempt: 1 })
  expect(w.store.lines(s.id).filter((l) => l.line.t === 'text').length).toBe(2)
})

test('one open session per ticket', async () => {
  w = await World.make()
  const t = ticket()
  w.store.putTicket(t)
  w.store.putReplay(t.id, [{ sleep: 5000 }])
  w.engine.submit(t, 'replay')
  expect(() => w.engine.submit(t, 'replay')).toThrow(/UNIQUE/)
})
