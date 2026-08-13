import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { FakeHost } from '@fixlane/fakes'
import { GitHub } from '@fixlane/hosts'
import { Db, Service, SyncServer } from '@fixlane/sync'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { Daemon } from '../../../bench/daemon.ts'
import { freshDb } from '../../sync/test/help.ts'
import type { TicketView } from '../src/index.ts'
import { FILES, GOOD, ticket } from './world.ts'

let root: string
let host: FakeHost
let url: string
let server: SyncServer
let sam: Daemon
let kim: Daemon
const users = { sam: 'token-of-sam-0123456789', kim: 'token-of-kim-0123456789' }

const serve = async (port = 0): Promise<void> => {
  const gh = new GitHub({ url: host.githubApi, token: host.token, hookSecret: host.hookSecret })
  server = new SyncServer({ service: new Service(new Db(url), { github: gh }), users, port })
  await server.start()
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fl-'))
  for (const [f, t] of Object.entries({ ...FILES, 'package.json': '{"type":"module"}' })) {
    mkdirSync(dirname(join(root, 'src', f)), { recursive: true })
    writeFileSync(join(root, 'src', f), t)
  }
  host = await new FakeHost(join(root, 'h')).listen()
  host.create('acme/depot', join(root, 'src'))
  const db = await freshDb()
  url = db.url
  await db.close()
  await serve()
  const desk = async (name: 'sam' | 'kim'): Promise<Daemon> => {
    const d = new Daemon(join(root, name[0]!), {
      // No API token on the desktops, only the one to push with. The server opens the pull requests.
      github: { url: 'http://127.0.0.1:1', git: `${host.origin}/git/{project}.git`, token: host.token },
      sync: { url: server.origin, token: users[name] },
      rounds: 1,
      pollMs: 200,
      retryMs: 50,
      heartbeatMs: 300,
    })
    expect(await d.start({ FIXLANE_USER: name })).toBe(true)
    return d
  }
  sam = await desk('sam')
  kim = await desk('kim')
  await sam.call('POST', '/v1/repos', { name: 'depot', host: 'github', project: 'acme/depot', mode: 'pr' })
  await sam.call('POST', '/v1/tickets', ticket())
  await expect.poll(() => view(kim)).toBeTruthy()
})
afterEach(async () => {
  for (const d of [sam, kim]) {
    for (const t of (await d.state().catch(() => null))?.tickets ?? []) {
      if (t.local && !['done', 'stopped'].includes(t.local.state))
        await d.call('POST', `/v1/sessions/${t.local.id}/cancel`, {}).catch(() => {})
    }
    await new Promise((r) => setTimeout(r, 300))
    await d.kill('SIGTERM')
  }
  await server.close()
  host.close()
  rmSync(root, { recursive: true, force: true })
})

const view = async (d: Daemon): Promise<TicketView | undefined> => (await d.state()).tickets[0]
const start = async (d: Daemon, steps: unknown[], moveHere = false): Promise<void> => {
  await d.call('POST', '/v1/tickets/sec-1/replay', steps)
  await d.call('POST', '/v1/tickets/sec-1/start', { runtime: 'replay', moveHere })
}
const sees = (d: Daemon, want: Partial<TicketView>) =>
  expect.poll(() => view(d), { timeout: 30_000 }).toMatchObject(want)

test('one desktop takes a ticket from the other while its agent is running', async () => {
  await start(sam, [{ sleep: 60_000 }])
  await sees(kim, { state: 'running', holder: 'sam', mine: false })
  await start(kim, GOOD, true)
  await expect
    .poll(async () => (await view(sam))!.local, { timeout: 10_000 })
    .toMatchObject({ state: 'stopped', reason: 'another desktop took this ticket' })
  await sees(sam, { state: 'in_review', mine: false })
  expect(host.pulls.map((p) => p.head)).toEqual(['fix/sec-1/2'])

  host.settle('acme/depot', 1, 'merged')
  const { headers, body } = host.hook('github', host.pulls[0]!)
  expect((await fetch(`${server.origin}/hooks/github`, { method: 'POST', headers, body })).status).toBe(200)
  await sees(kim, { state: 'done' })
  await sees(sam, { state: 'done' })
}, 60_000)

test('without taking it over, the second desktop waits', async () => {
  await start(sam, [{ sleep: 60_000 }])
  await sees(kim, { state: 'running', holder: 'sam' })
  await start(kim, GOOD)
  await expect
    .poll(async () => (await view(kim))!.local, { timeout: 10_000 })
    .toMatchObject({ state: 'queued', note: 'sam has this ticket' })
}, 60_000)

test('the server goes away in the middle: the work goes on, and the pull request follows later', async () => {
  const port = Number(new URL(server.origin).port)
  await start(sam, [{ sleep: 1500 }, ...GOOD])
  await sees(sam, { state: 'running' })
  await server.close()
  await expect.poll(async () => (await view(sam))!.state, { timeout: 20_000 }).toBe('proposing')
  expect((await sam.state()).online).toBe(false)
  await sam.call('POST', '/v1/tickets/sec-1/comment', { text: 'written offline' })
  await new Promise((r) => setTimeout(r, 2500))
  expect(host.pulls).toEqual([])
  await serve(port)
  await sees(sam, { state: 'in_review' })
  await sees(kim, { state: 'in_review', comments: [{ actor: 'sam', text: 'written offline' }] })
  expect(host.pulls.length).toBe(1)
}, 90_000)
