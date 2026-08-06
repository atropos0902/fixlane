import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeHost } from '@fixlane/fakes'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { BadSignature, type GitHost, GitHub, GitLab, HostError, waitFrom } from '../src/index.ts'

const P = 'acme/depot'
let root: string
let fake: FakeHost
let slept: number[]

const pace = { tries: 6, now: Date.now, sleep: async (ms: number) => void slept.push(ms) }
const adapters: [string, () => GitHost][] = [
  ['github', () => new GitHub({ url: fake.githubApi, token: fake.token, hookSecret: fake.hookSecret, pace })],
  ['gitlab', () => new GitLab({ url: fake.gitlabUrl, token: fake.token, hookSecret: fake.hookSecret, pace })],
]
const draft = { head: 'fix/sec-1/1', base: 'main', title: 'Fix', body: 'b' }

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fixlane-host-'))
  writeFileSync(join(root, 'f'), 'x')
  fake = await new FakeHost(join(root, 'repos')).listen()
  fake.create(P, root)
  execFileSync('git', ['-C', fake.dir(P), 'branch', draft.head, 'main'])
  slept = []
})
afterEach(() => {
  fake.close()
  rmSync(root, { recursive: true, force: true })
})

describe.each(adapters)('%s', (kind, make) => {
  const fails = (fault: (typeof fake.faults)[number]['fault'], method: 'GET' | 'POST', times = 1): void => {
    fake.faults.push({ fault, method, times })
  }

  test('opens, finds and reads one', async () => {
    const h = make()
    expect(await h.findPull(P, draft.head)).toBeNull()
    const p = await h.openPull(P, draft)
    expect(p).toMatchObject({ number: 1, head: draft.head, state: 'open' })
    expect(await h.findPull(P, draft.head)).toEqual(p)
    expect(await h.getPull(P, 1)).toEqual(p)
    expect(await h.getPull(P, 99)).toBeNull()
  })

  test('opening again returns the same one, also when it was merged or closed', async () => {
    const h = make()
    await h.openPull(P, draft)
    fake.settle(P, 1, 'merged')
    expect((await h.openPull(P, draft)).state).toBe('merged')
    fake.settle(P, 1, 'closed')
    expect((await h.openPull(P, draft)).state).toBe('closed')
    expect(fake.pulls.length).toBe(1)
  })

  test('two at once make one', async () => {
    const [a, b] = await Promise.all([make().openPull(P, draft), make().openPull(P, draft)])
    expect(a.number).toBe(b.number)
    expect(fake.pulls.length).toBe(1)
  })

  test.each([
    'lost-answer',
    'done-but-502',
    'error-500',
    'rate-limit',
    'rate-reset',
  ] as const)('%s on create still leaves exactly one', async (f) => {
    fails(f, 'POST')
    expect((await make().openPull(P, draft)).number).toBe(1)
    expect(fake.pulls.length).toBe(1)
  })

  test('created, answer lost, and the list does not show it yet', async () => {
    fails('lost-answer', 'POST')
    fails('stale-list', 'POST')
    expect((await make().openPull(P, draft)).number).toBe(1)
    expect(fake.pulls.length).toBe(1)
  })

  test('a limit is waited out for as long as the host says', async () => {
    fails('rate-limit', 'GET')
    await make().findPull(P, draft.head)
    expect(slept).toEqual([1000])
  })

  test('a reset time counts too', async () => {
    fails('rate-reset', 'GET')
    await make().findPull(P, draft.head)
    expect(slept.length).toBe(1)
    expect(slept[0]).toBeGreaterThan(0)
    expect(slept[0]).toBeLessThanOrEqual(2000)
  })

  test('gives up after its tries, backing off in between', async () => {
    fails('error-500', 'GET', 99)
    await expect(make().findPull(P, draft.head)).rejects.toBeInstanceOf(HostError)
    expect(slept).toEqual([250, 500, 1000, 2000, 4000])
  })

  test('a refusal is not retried', async () => {
    await expect(make().openPull(P, { ...draft, head: 'fix/none/1' })).rejects.toThrow()
    expect(slept).toEqual([])
  })

  test('branch heads', async () => {
    expect(await make().headSha(P, draft.head)).toBe(fake.sha(P, draft.head))
    expect(await make().headSha(P, 'fix/none/1')).toBeNull()
  })

  test('webhooks: signed ones are read, others are refused', async () => {
    const h = make()
    await h.openPull(P, draft)
    const { headers, body } = fake.hook(kind as 'github', fake.pulls[0]!, 'd-1')
    expect(h.readHook(headers, body)).toEqual({ delivery: 'd-1', project: P, number: 1 })
    const key = kind === 'github' ? 'x-hub-signature-256' : 'x-gitlab-token'
    expect(() => h.readHook({ ...headers, [key]: 'nope' }, body)).toThrow(BadSignature)
    expect(() => h.readHook({ ...headers, [key]: undefined }, body)).toThrow(BadSignature)
    const other = kind === 'github' ? { 'x-github-event': 'push' } : { 'x-gitlab-event': 'Push Hook' }
    expect(h.readHook({ ...headers, ...other }, body)).toBeNull()
    if (kind === 'github') expect(() => h.readHook(headers, `${body} `)).toThrow(BadSignature)
  })
})

describe('waitFrom', () => {
  test('retry-after wins', () =>
    expect(waitFrom(429, { 'retry-after': '7', 'ratelimit-reset': '9' }, 0)).toBe(7000))
  test('a reset only matters when the limit is what was hit', () => {
    expect(waitFrom(403, { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '9' }, 0)).toBeNull()
    expect(waitFrom(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '9' }, 4000)).toBe(5000)
    expect(waitFrom(429, { 'ratelimit-reset': '9' }, 10_000)).toBe(0)
    expect(waitFrom(500, {}, 0)).toBeNull()
  })
})
