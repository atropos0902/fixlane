import { execFileSync } from 'node:child_process'
import { apply, emptyBoard } from '@fixlane/core'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { SyncClient, SyncServer } from '../src/index.ts'
import { filed, freshDb, Hosted, Memory, repo, Service, said } from './help.ts'

let h: Hosted
let server: SyncServer
let url: string
const clients: SyncClient[] = []
const users = { sam: 'token-of-sam-0123456789', kim: 'token-of-kim-0123456789' }

const start = async (port = 0): Promise<void> => {
  const db = new (await import('../src/index.ts')).Db(url)
  server = new SyncServer({ service: new Service(db, { github: h.gh() }), users, port })
  await server.start()
}
beforeEach(async () => {
  const db = await freshDb()
  url = db.url
  await db.close()
  h = await new Hosted().start()
  await start()
})
afterEach(async () => {
  for (const c of clients.splice(0)) c.disconnect()
  await server.close()
  h.stop()
})

const desk = (name: keyof typeof users, mem = new Memory()) => {
  const c = new SyncClient(server.origin, users[name], mem)
  clients.push(c)
  return { c, mem, board: () => mem.entries.reduce(apply, emptyBoard()) }
}
const same = (...ds: ReturnType<typeof desk>[]) =>
  expect.poll(
    () =>
      new Set(ds.map((d) => JSON.stringify([...d.board().cards]))).size === 1 &&
      ds.every((d) => d.mem.out.length === 0),
  )

test('two desktops see the same board', async () => {
  const [a, b] = [desk('sam'), desk('kim')]
  a.c.connect()
  b.c.connect()
  await a.c.addRepo(repo)
  a.c.append(filed('sec-1'))
  await expect.poll(() => b.board().cards.size).toBe(1)
  b.c.append(said('sec-1', 'mine'))
  await expect.poll(() => a.board().cards.get('sec-1')!.comments).toEqual([{ actor: 'kim', text: 'mine' }])
})

test('work done offline goes out in order, once, and everybody ends up with the same board', async () => {
  const [a, b] = [desk('sam'), desk('kim')]
  a.c.connect()
  b.c.connect()
  await a.c.addRepo(repo)
  a.c.append(filed('sec-1'))
  await expect.poll(() => b.board().cards.size).toBe(1)
  b.c.disconnect()
  a.c.disconnect()
  for (let i = 0; i < 20; i++) {
    a.c.append(said('sec-1', `a${i}`))
    b.c.append(said('sec-1', `b${i}`))
  }
  a.c.connect()
  b.c.connect()
  await same(a, b).toBe(true)
  const texts = a
    .board()
    .cards.get('sec-1')!
    .comments.map((x) => x.text)
  expect(texts.length).toBe(40)
  expect(texts.filter((t) => t.startsWith('a'))).toEqual(Array.from({ length: 20 }, (_, i) => `a${i}`))
})

test('a server that goes away and comes back loses nothing', async () => {
  const [a, b] = [desk('sam'), desk('kim')]
  const port = Number(new URL(server.origin).port)
  a.c.connect()
  b.c.connect()
  await a.c.addRepo(repo)
  a.c.append(filed('sec-1'))
  await expect.poll(() => b.board().cards.size).toBe(1)
  const sending = setInterval(() => a.c.append(said('sec-1', String(Math.random()))), 5)
  await new Promise((r) => setTimeout(r, 150))
  await server.close()
  await new Promise((r) => setTimeout(r, 300))
  await start(port)
  await new Promise((r) => setTimeout(r, 300))
  clearInterval(sending)
  await same(a, b).toBe(true)
  const texts = a
    .board()
    .cards.get('sec-1')!
    .comments.map((x) => x.text)
  expect(new Set(texts).size).toBe(texts.length)
  expect(texts.length).toBeGreaterThan(50)
})

test('a lost database connection is made again', async () => {
  const [a, b] = [desk('sam'), desk('kim')]
  a.c.connect()
  b.c.connect()
  await a.c.addRepo(repo)
  a.c.append(filed('sec-1'))
  await expect.poll(() => b.board().cards.size).toBe(1)
  execFileSync('docker', [
    'exec',
    'fixlane-postgres-1',
    'psql',
    '-qU',
    'fixlane',
    '-c',
    `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${new URL(url).pathname.slice(1)}'`,
  ])
  a.c.append(said('sec-1', 'after'))
  await expect.poll(() => b.board().cards.get('sec-1')!.comments.length, { timeout: 10_000 }).toBe(1)
})

test('a draft the server refuses is dropped, and the ones behind it still go', async () => {
  const a = desk('sam')
  const refused: string[] = []
  a.c.on('refused', (r) => refused.push(r.reason))
  a.c.connect()
  await a.c.addRepo(repo)
  a.c.append(said('nope', 'x'))
  a.c.append(filed('sec-1'))
  await expect.poll(() => a.board().cards.size).toBe(1)
  expect(refused).toEqual(['no ticket nope'])
})

test('strangers get nothing', async () => {
  const post = (path: string, token: string, body: unknown = {}) =>
    fetch(`${server.origin}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  expect((await post('/v1/append', 'wrong', filed('x'))).status).toBe(401)
  expect((await post('/v1/append', '', filed('x'))).status).toBe(401)
  expect((await post('/v1/append', users.sam, { type: 'lease.taken' })).status).toBe(400)
  expect((await post('/hooks/github', 'x', {})).status).toBe(401)
  const mem = new Memory()
  const c = new SyncClient(server.origin, 'wrong-token', mem)
  clients.push(c)
  let opened = false
  c.on('online', (on) => {
    opened ||= on
  })
  c.connect()
  await new Promise((r) => setTimeout(r, 300))
  expect(opened).toBe(false)
})
