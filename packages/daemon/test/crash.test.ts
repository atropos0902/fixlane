import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isOver, type Pull, Repo, type RunnerLine, type TestRun, Ticket } from '@fixlane/core'
import { Mirror } from '@fixlane/gitstore'
import type { GitHost } from '@fixlane/hosts'
import type { AgentExit, AgentRun, Sandbox } from '@fixlane/sandbox'
import fc from 'fast-check'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { Engine, LocalCoordinator, Store } from '../src/index.ts'

// The engine on real git and a real database, with the containers and the host simulated, so that
// hundreds of crash plans can be tried in seconds. bench/crash.ts does the same with nothing simulated.

let root: string
let upstream: string
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fl-crash-'))
  upstream = join(root, 'up.git')
  const sh = (s: string): unknown => execFileSync('bash', ['-ec', s], { cwd: root })
  sh(
    `git init -q --bare -b main up.git; git init -q -b main seed; cd seed; mkdir test; echo a > a.js; echo t > test/a.test.js; git add .; git -c user.name=a -c user.email=a@b commit -qm i; git push -q ../up.git main`,
  )
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

type Kind = 'good' | 'unproven' | 'stops' | 'fails'

/** Outlives the daemon, as containers do. */
class World implements Sandbox {
  readonly objectsAs = null
  readonly containers = new Map<string, { session: string; lines: RunnerLine[] }>()
  readonly pulls: Pull[] = []
  creates = 0
  readonly kind: Kind
  constructor(kind: Kind) {
    this.kind = kind
  }

  async prepare(): Promise<void> {}
  async startAgent(run: AgentRun): Promise<void> {
    if (this.containers.has(run.name)) return
    const lines: RunnerLine[] = [{ t: 'text', text: 'working' }]
    if (this.kind === 'stops') lines.push({ t: 'stop', reason: 'nothing to fix' })
    else if (this.kind !== 'fails') {
      writeFileSync(join(run.workspace, 'a.js'), 'b\n')
      writeFileSync(join(run.workspace, 'test', 'b.test.js'), 'x\n')
    }
    lines.push(this.kind === 'fails' ? { t: 'end', ok: false, error: 'model error' } : { t: 'end', ok: true })
    this.containers.set(run.name, { session: run.session, lines })
  }
  async follow(name: string, onLine: (l: RunnerLine, n: number) => void): Promise<AgentExit> {
    const c = this.containers.get(name)
    if (!c) return { lines: [], finished: false }
    for (const [n, l] of c.lines.entries()) onLine(l, n)
    return { lines: c.lines, finished: true }
  }
  async harvest(run: AgentRun, base: string): Promise<Buffer | null> {
    const git = (...a: string[]): Buffer =>
      execFileSync('git', ['-c', 'user.name=a', '-c', 'user.email=a@b', ...a], {
        cwd: run.workspace,
        stdio: 'pipe',
      })
    git('add', '-A')
    if (git('status', '--porcelain').length > 0) git('commit', '-qm', 'work')
    return git('bundle', 'create', '-q', '-', `${base}..HEAD`)
  }
  async test(job: { tree: string }): Promise<TestRun> {
    const has = existsSync(join(job.tree, 'test', 'b.test.js'))
    const fixed = job.tree.includes('head')
    const results: TestRun['results'] = [
      { file: 'test/a.test.js', name: 'a', outcome: 'pass', assertion: false },
    ]
    if (has) {
      const red = this.kind === 'good' && !fixed
      results.push({ file: 'test/b.test.js', name: 'b', outcome: red ? 'fail' : 'pass', assertion: red })
    }
    return { results, exit: results.some((r) => r.outcome === 'fail') ? 1 : 0 }
  }
  async install(): Promise<{ ok: boolean; log: string }> {
    return { ok: true, log: '' }
  }
  async stop(name: string): Promise<void> {
    this.containers.delete(name)
  }
  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async clear(session: string, keep: readonly string[] = []): Promise<void> {
    for (const [n, c] of this.containers)
      if (c.session === session && !keep.includes(n)) this.containers.delete(n)
  }
  async sessions(): Promise<string[]> {
    return [...new Set([...this.containers.values()].map((c) => c.session))]
  }

  host(dies: () => boolean): GitHost {
    const find = (head: string): Pull | null => this.pulls.find((p) => p.head === head) ?? null
    return {
      kind: 'github',
      findPull: async (_, head) => find(head),
      getPull: async (_, n) => this.pulls.find((p) => p.number === n) ?? null,
      headSha: async () => null,
      readHook: () => null,
      openPull: async (_, p) => {
        const there = find(p.head)
        if (there) return there
        const pull: Pull = { number: this.pulls.length + 1, url: 'u', head: p.head, state: 'open' }
        this.pulls.push(pull)
        this.creates++
        if (dies()) throw new Error('crash')
        return pull
      },
    }
  }
}

let n = 0
async function live(kind: Kind, crashes: readonly number[]): Promise<void> {
  const dir = join(root, String(++n))
  mkdirSync(dir)
  const world = new World(kind)
  const plan = [...crashes]
  let session = ''
  const t = Ticket.parse({ id: 'sec-1', repo: 'depot', kind: 'code', title: 'x', body: '' })
  for (let life = 0; ; life++) {
    let left = plan.shift() ?? Number.POSITIVE_INFINITY
    let dead = false
    const die = (): boolean => {
      if (!dead && --left <= 0) dead = true
      return dead
    }
    const store = new Store(join(dir, 'db'), () => {
      if (die()) throw new Error('crash')
    })
    if (life === 0) {
      store.putRepo(Repo.parse({ name: 'depot', host: 'github', project: 'a/b', mode: 'pr' }))
      store.putTicket(t)
    }
    const engine = new Engine({
      store,
      sandbox: world,
      coordinator: new LocalCoordinator(store, { github: world.host(die) }),
      mirror: (r) => new Mirror(join(dir, 'm', `${r.name}.git`), { url: upstream, user: '', token: '' }),
      dir,
      registry: '',
      rounds: 1,
      pollMs: 10,
      retryMs: 1,
    })
    await engine.recover()
    if (life === 0) session = engine.submit(t, 'replay').id
    const end = (): boolean => {
      const s = store.session(session)!
      const pull = world.pulls[0]
      if (s.state === 'in_review' && pull) pull.state = 'merged'
      return isOver(s.state)
    }
    const until = Date.now() + 15_000
    while (!dead && !end() && Date.now() < until) await new Promise((r) => setTimeout(r, 3))
    if (!dead) await new Promise((r) => setTimeout(r, 60))
    // A dead engine must not touch anything again, so it is closed before the next one looks.
    await engine.close()
    await new Promise((r) => setTimeout(r, dead ? 80 : 20))
    if (dead) {
      store.close()
      continue
    }
    const s = store.session(session)!
    expect(s.state).toBe(kind === 'good' ? 'done' : 'stopped')
    expect(world.creates).toBe(kind === 'good' ? 1 : 0)
    expect(s.attempt).toBeLessThanOrEqual(2)
    await engine.recover()
    await new Promise((r) => setTimeout(r, 20))
    expect(world.containers.size).toBe(0)
    for (const d of ['work', 's', 'trees', 'review']) expect(readdirSync(join(dir, d))).toEqual([])
    const was = store.moves(session)
    for (const [i, m] of was.entries()) if (i > 0) expect(m.was).toBe(was[i - 1]!.now)
    store.close()
    rmSync(dir, { recursive: true, force: true })
    return
  }
}

test('whatever the crash plan, there is one pull request or none, and nothing is left behind', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<Kind>('good', 'good', 'good', 'unproven', 'stops', 'fails'),
      fc.array(fc.integer({ min: 1, max: 24 }), { maxLength: 4 }),
      live,
    ),
    { numRuns: Number(process.env.RUNS ?? 60) },
  )
}, 300_000)
