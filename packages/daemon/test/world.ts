import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Repo, Ticket } from '@fixlane/core'
import { FakeHost, FakeRegistry, type Packages } from '@fixlane/fakes'
import { Mirror } from '@fixlane/gitstore'
import { GitHub } from '@fixlane/hosts'
import { DockerSandbox } from '@fixlane/sandbox'
import { Engine, type EngineOptions, LocalCoordinator, Store } from '../src/index.ts'

export const KEY = 'q8Zt-vault-41f9c07d2b'
export const PACKAGES: Packages = {
  'tiny-tmpl': {
    '2.1.3': { 'index.js': 'module.exports = (s) => s' },
    '2.1.4': { 'index.js': 'module.exports = (s) => String(s)' },
  },
}

export const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    { name: 'depot', version: '1.0.0', type: 'module', dependencies: { 'tiny-tmpl': '^2.1.0' } },
    null,
    2,
  ),
  'src/join.js': `export const join = (root, name) => root + '/' + name\n`,
  'src/mail.js': `export const key = '${KEY}'\n`,
  'test/join.test.js': `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from '../src/join.js'
test('joins', () => assert.equal(join('/a', 'b'), '/a/b'))
`,
}

export const FIX = `export const join = (root, name) => {
  if (name.split('/').includes('..')) throw new Error('outside')
  return root + '/' + name
}
`
export const NEW_TEST = `import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from '../src/join.js'
test('stays inside', () => assert.throws(() => join('/a', '../b')))
`
export const GOOD = [
  { write: 'src/join.js', text: FIX },
  { write: 'test/inside.test.js', text: NEW_TEST },
]

export const ticket = (o: Partial<Ticket> = {}): Ticket =>
  Ticket.parse({
    id: 'sec-1',
    repo: 'depot',
    kind: 'code',
    title: 'Path traversal in join',
    body: 'join() leaves its root.',
    ...o,
  })
export const dependency = (): Ticket =>
  ticket({
    id: 'dep-1',
    kind: 'dependency',
    title: 'Bump tiny-tmpl',
    advisory: { id: 'ADV-1', package: 'tiny-tmpl', affected: '<2.1.4', text: 'bad' },
  })
export const secret = (): Ticket =>
  ticket({
    id: 'key-1',
    kind: 'secret',
    title: 'Key in mail.js',
    key: { sha256: createHash('sha256').update(KEY).digest('hex'), length: KEY.length },
  })

export class World {
  // Below a directory that exists in the image and is closed to the agent's user, as a home can be.
  readonly root = mkdtempSync(join(process.getuid?.() === 0 ? homedir() : tmpdir(), '.fl-'))
  readonly owner = `w${process.pid}-${this.root.slice(-6)}`
  host!: FakeHost
  registry!: FakeRegistry
  store!: Store
  engine!: Engine
  box!: DockerSandbox

  static async make(mode: 'pr' | 'branch' = 'pr', o: Partial<EngineOptions> = {}): Promise<World> {
    const w = new World()
    w.host = await new FakeHost(join(w.root, 'host')).listen()
    w.registry = await new FakeRegistry(PACKAGES).listen()
    const src = join(w.root, 'src')
    const origin = w.registry.origin
    const v = '2.1.3'
    const lock = {
      name: 'depot',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: 'depot', version: '1.0.0', dependencies: { 'tiny-tmpl': '^2.1.0' } },
        'node_modules/tiny-tmpl': {
          version: v,
          resolved: `${origin}/tiny-tmpl/-/tiny-tmpl-${v}.tgz`,
          integrity: w.registry.integrity('tiny-tmpl', v),
        },
      },
    }
    for (const [f, t] of Object.entries({
      ...FILES,
      'package-lock.json': `${JSON.stringify(lock, null, 2)}\n`,
    })) {
      mkdirSync(dirname(join(src, f)), { recursive: true })
      writeFileSync(join(src, f), t)
    }
    w.host.create('acme/depot', src)
    w.store = new Store(join(w.root, 'db'))
    w.store.putRepo(Repo.parse({ name: 'depot', host: 'github', project: 'acme/depot', mode }))
    w.boot(o)
    await w.engine.recover()
    return w
  }

  boot(o: Partial<EngineOptions> = {}): void {
    this.box = new DockerSandbox({ owner: this.owner })
    const gh = new GitHub({
      url: this.host.githubApi,
      token: this.host.token,
      hookSecret: this.host.hookSecret,
    })
    this.engine = new Engine({
      store: this.store,
      sandbox: this.box,
      coordinator: new LocalCoordinator(this.store, { github: gh }),
      mirror: (r) =>
        new Mirror(join(this.root, 'm', `${r.name}.git`), {
          url: this.host.gitUrl(r.project),
          user: 'x',
          token: this.host.token,
        }),
      dir: this.root,
      registry: this.registry.origin,
      rounds: 1,
      pollMs: 100,
      retryMs: 50,
      ...o,
    })
  }

  async close(): Promise<void> {
    await this.engine.close()
    for (const s of await this.box.sessions()) await this.box.clear(s)
    this.store.close()
    this.host.close()
    this.registry.close()
    rmSync(this.root, { recursive: true, force: true })
  }
}
