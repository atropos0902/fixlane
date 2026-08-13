import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeModels, FakeRegistry } from '@fixlane/fakes'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Proxies, type ProxyOptions } from '../src/index.ts'

let dir: string
let models: FakeModels
let registry: FakeRegistry
let p: Proxies
let spent = 0
let usage: number[][] = []
const extra: Server[] = []

const open = async (o: Partial<ProxyOptions> = {}): Promise<void> => {
  p = await Proxies.open({
    dir,
    anthropic: { url: models.origin, headers: { 'x-api-key': 'real-anthropic-key' } },
    openai: { url: models.origin, headers: { authorization: 'Bearer real-openai-key' } },
    registry: registry.origin,
    packages: ['a'],
    budget: 1000,
    prices: { fake: { in: 3, out: 15 } },
    spent: () => spent,
    onUsage: (...u) => usage.push(u),
    ...o,
  })
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fl-'))
  spent = 0
  usage = []
  models = await new FakeModels([{ text: 'hi' }, { text: 'hi' }]).listen()
  registry = await new FakeRegistry({
    a: {
      '1.0.0': {
        'index.js': '',
        'package.json': JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { b: '1' } }),
      },
    },
    b: { '1.0.0': { 'index.js': '' } },
    secret: { '1.0.0': { 'index.js': '' } },
  }).listen()
})
afterEach(() => {
  p.close()
  models.close()
  registry.close()
  for (const s of extra.splice(0)) s.close()
  rmSync(dir, { recursive: true, force: true })
})

const call = (
  sock: 'model' | 'packages',
  method: string,
  path: string,
  body = '',
  headers: Record<string, string> = {},
) =>
  new Promise<{ status: number; text: string }>((resolve, reject) => {
    const q = request({ socketPath: join(dir, `${sock}.sock`), method, path, headers }, (r) => {
      let text = ''
      r.on('data', (d) => {
        text += d
      })
      r.on('end', () => resolve({ status: r.statusCode ?? 0, text }))
    })
    q.on('error', reject)
    q.end(body)
  })
const ask = (path = '/v1/messages', headers = {}) => call('model', 'POST', path, '{"tools":[]}', headers)

describe('models', () => {
  test('get our key, whatever the container sends', async () => {
    await open()
    await ask('/v1/messages', { 'x-api-key': 'guess', authorization: 'Bearer guess' })
    await ask('/v1/responses', { authorization: 'Bearer guess' })
    expect(models.calls.map((c) => c.auth)).toEqual(['real-anthropic-key', 'Bearer real-openai-key'])
  })

  test('are reached on their own paths only', async () => {
    await open()
    for (const path of [
      '/',
      '/v1/files',
      '/v1/messages/../files',
      '/v1/messages/batches',
      '/v1/organizations/api_keys',
    ]) {
      expect((await ask(path)).status).toBe(404)
    }
    expect((await call('model', 'GET', '/v1/messages')).status).toBe(404)
    expect((await call('model', 'POST', 'http://169.254.169.254/v1/files')).status).toBe(404)
    expect(models.calls).toEqual([])
  })

  test('a full URL in the request does not change where it goes', async () => {
    await open()
    expect((await call('model', 'POST', 'http://evil.example/v1/messages', '{}')).status).toBe(200)
    expect(models.calls.length).toBe(1)
  })

  test('tokens and cost are counted from the answer', async () => {
    await open()
    await ask()
    await ask('/v1/responses')
    await expect.poll(() => usage.length).toBe(2)
    expect(usage[0]).toEqual([1000, 50, 1000 * 3 + 50 * 15])
    expect(usage[1]!.slice(0, 2)).toEqual([1000, 50])
  })

  test('stop at the budget', async () => {
    await open()
    spent = 1000
    expect((await ask()).status).toBe(403)
    expect(models.calls).toEqual([])
  })

  test('a vendor without a key is refused', async () => {
    await open({ openai: null })
    expect((await ask('/v1/responses')).status).toBe(403)
  })

  test('an answer that breaks off is still counted', async () => {
    const s = createServer((_, r) => {
      r.write(
        'data: {"type":"message_start","message":{"model":"fake","usage":{"input_tokens":70,"output_tokens":1}}}\n\n',
      )
      setTimeout(() => r.destroy(), 30)
    })
    extra.push(s)
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
    await open({ anthropic: { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, headers: {} } })
    await ask().catch(() => {})
    await expect.poll(() => usage).toEqual([[70, 1, 70 * 3 + 15]])
  })
})

describe('packages', () => {
  const get = (path: string, method = 'GET') => call('packages', method, path)
  test('known ones are served, and so is what they depend on once that is known', async () => {
    await open()
    expect((await get('/b')).status).toBe(403)
    expect((await get('/a')).status).toBe(200)
    expect((await get('/b')).status).toBe(200)
    expect((await get('/a/-/a-1.0.0.tgz')).status).toBe(200)
  })
  test('others are not, so a name cannot carry anything out', async () => {
    await open()
    for (const path of [
      '/secret',
      '/stolen-key-abc123',
      '/@x/stolen',
      '/secret/-/secret-1.0.0.tgz',
      '/-/npm/v1/security',
      '/..%2f..%2fx',
      '/a/../secret',
    ]) {
      expect((await get(path)).status).toBeGreaterThanOrEqual(400)
    }
    expect((await get('/a?x=stolen')).status).toBe(405)
    expect((await get('/a', 'PUT')).status).toBe(405)
    expect(registry.requests).toEqual([])
  })
})
