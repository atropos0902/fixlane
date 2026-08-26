// Kills the daemon with SIGKILL at every point it can be caught at, and at random moments.
// usage: node bench/crash.ts [runs] [shards]
import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeHost } from '@fixlane/fakes'
import { Daemon, random, until } from './daemon.ts'

const [runs = 500, shards = 3] = process.argv.slice(2, 4).map(Number)
const shard = process.env.SHARD

const POINTS = [
  ...[
    'queued>cloning',
    'cloning>running',
    'running>checking',
    'checking>proposing',
    'proposing>in_review',
    'in_review>done',
  ].flatMap((m) => [`before:${m}`, `after:${m}`]),
  'leased',
  'cloned',
  'prepared',
  'agent started',
  'agent ended',
  'harvested',
  'imported',
  'pushed',
  'proposed',
  'worktree',
  'tidied',
]
const BAD_POINTS = [
  'before:checking>cloning',
  'after:checking>cloning',
  'before:checking>stopped',
  'after:checking>stopped',
  'cloned#2',
  'agent started#2',
  'imported#2',
]
const STOP_POINTS = ['before:running>stopped', 'after:running>stopped', 'tidied']

const FILES: Record<string, string> = {
  'package.json': '{"name":"depot","type":"module"}',
  'join.js': "export const join = (root, name) => root + '/' + name\n",
  'test/join.test.js':
    "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { join } from '../join.js'\ntest('joins', () => assert.equal(join('/a', 'b'), '/a/b'))\n",
}
const fix = {
  write: 'join.js',
  text: "export const join = (root, name) => {\n  if (name.includes('..')) throw new Error('outside')\n  return root + '/' + name\n}\n",
}
const good = [
  fix,
  {
    write: 'test/in.test.js',
    text: "import { test } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { join } from '../join.js'\ntest('stays inside', () => assert.throws(() => join('/a', '../b')))\n",
  },
]
const KINDS = {
  good: { steps: [{ sleep: 150 }, ...good], points: POINTS, end: 'done' },
  bad: { steps: [fix], points: BAD_POINTS, end: 'stopped' },
  stop: { steps: [{ stop: 'join already refuses that' }], points: STOP_POINTS, end: 'stopped' },
} as const

async function work(index: number): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'fl-'))
  for (const [f, t] of Object.entries(FILES)) {
    mkdirSync(join(root, 'src', f, '..'), { recursive: true })
    writeFileSync(join(root, 'src', f), t)
  }
  const host = await new FakeHost(join(root, 'h')).listen()
  host.create('acme/depot', join(root, 'src'))
  const d = new Daemon(join(root, 'd'), {
    github: { url: host.githubApi, git: `${host.origin}/git/{project}.git`, token: host.token },
    repos: [{ name: 'depot', host: 'github', project: 'acme/depot', mode: 'pr' }],
    rounds: 1,
    pollMs: 100,
    retryMs: 50,
  })
  const out: object[] = []
  for (let i = index; i < runs; i += shards) {
    const rnd = random(i + 1)
    const kind = i % 10 === 8 ? 'bad' : i % 10 === 9 ? 'stop' : 'good'
    const k = KINDS[kind]
    const id = `t-${i}`
    const kills: string[] = []
    const problems: string[] = []
    let deaths = 0
    if (rnd() < 0.2)
      host.faults.push({ fault: rnd() < 0.5 ? 'lost-answer' : 'done-but-502', method: 'POST', times: 1 })

    if (!(await d.start())) throw new Error(d.log)
    await d.call('POST', '/v1/tickets', {
      id,
      repo: 'depot',
      kind: 'code',
      title: 'Path traversal',
      body: '',
    })
    await d.call('POST', `/v1/tickets/${id}/replay`, k.steps)
    await d.kill()
    let begun = false
    // Every point in turn, then one or two more anywhere, half of them at a random moment.
    const plan = [
      k.points[Math.floor(i / 10) % k.points.length]!,
      ...Array.from({ length: rnd() < 0.5 ? 1 : 2 }, () => k.points[Math.floor(rnd() * k.points.length)]!),
    ]
    if (kind === 'good') plan[0] = k.points[i % k.points.length]!
    let session = ''
    const finished = async (): Promise<boolean> => {
      if (!d.alive) return true
      const t = (await d.state().catch(() => null))?.tickets.find((x) => x.ticket.id === id)
      if (t?.local) session = t.local.id
      if (t?.state === 'in_review') {
        const p = host.pulls.find((x) => x.head.startsWith(`fix/${id}/`))
        if (p) host.settle('acme/depot', p.number, 'merged')
      }
      if (t?.state !== 'done' && t?.state !== 'stopped') return false
      const left = ['work', 's', 'trees', 'm/depot.git/holds'].flatMap((x) => readdirSync(join(d.dir, x)))
      return left.length === 0 && !readdirSync(join(d.dir, 'review')).includes(id)
    }
    const begin = async (): Promise<void> => {
      if (begun) return
      begun = true
      await d.call('POST', `/v1/tickets/${id}/start`, { runtime: 'replay' }).catch(() => {})
    }
    for (const point of plan) {
      const atRandom = kills.length > 0 && rnd() < 0.5
      const alive = await d.start(atRandom ? {} : { FIXLANE_KILL_AT: point })
      kills.push(atRandom ? 'any moment' : point)
      if (alive) await begin()
      if (atRandom) {
        await new Promise((r) => setTimeout(r, rnd() * 3500))
        await d.kill()
      } else {
        await until(finished, 40_000)
      }
      if (d.alive) await d.kill()
      deaths++
    }
    if (!(await d.start())) problems.push(`did not start: ${d.log}`)
    await begin()
    if (!(await until(finished, 60_000))) problems.push('did not finish')

    const t = (await d.state()).tickets.find((x) => x.ticket.id === id)
    if (t?.state !== k.end) problems.push(`ended ${t?.state}: ${t?.note}`)
    const pulls = host.pulls.filter((p) => p.head.startsWith(`fix/${id}/`))
    if (pulls.length !== (kind === 'good' ? 1 : 0)) problems.push(`${pulls.length} pull requests`)
    const n = (await d.call<{ session: { attempt: number } }>('GET', `/v1/sessions/${session}`)).session
      .attempt
    if (n > 2) problems.push(`attempt ${n}`)
    await d.kill()
    const mine = execFileSync('docker', ['ps', '-aq', '--filter', `label=fixlane.session=${session}`], {
      encoding: 'utf8',
    }).trim()
    if (mine) problems.push('a container was left')
    for (const x of ['work', 's', 'trees', 'review']) {
      const left = readdirSync(join(d.dir, x)).filter((f) => f.startsWith(session) || f === id)
      if (left.length) problems.push(`left ${x}/${left}`)
    }
    out.push({ run: i, kind, kills, deaths, problems })
    console.log(JSON.stringify(out.at(-1)))
  }
  host.close()
  rmSync(root, { recursive: true, force: true })
}

if (shard !== undefined) {
  await work(Number(shard))
  process.exit(0)
}
const started = Date.now()
const all = await Promise.all(
  Array.from({ length: shards }, (_, i) => {
    const p = spawn(process.execPath, [import.meta.filename, String(runs), String(shards)], {
      env: { ...process.env, SHARD: String(i) },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let text = ''
    p.stdout.on('data', (b: Buffer) => {
      text += b
      process.stderr.write(`\r${text.split('\n').length - 1} in shard ${i}   `)
    })
    return new Promise<string>((r) => p.on('exit', () => r(text)))
  }),
)
interface Row {
  run: number
  kind: string
  kills: string[]
  deaths: number
  problems: string[]
}
const rows = all
  .flatMap((t) =>
    t
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Row),
  )
  .sort((a, b) => a.run - b.run)
const by = (f: (r: Row) => string[]) => {
  const m: Record<string, number> = {}
  for (const r of rows) for (const k of f(r)) m[k] = (m[k] ?? 0) + 1
  return m
}
const result = {
  runs: rows.length,
  deaths: rows.reduce((n, r) => n + r.deaths, 0),
  kinds: by((r) => [r.kind]),
  points: by((r) => r.kills),
  failed: rows.filter((r) => r.problems.length > 0),
  seconds: Math.round((Date.now() - started) / 1000),
}
writeFileSync(new URL('results/crash.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
console.log(`\n${result.runs} runs, ${result.deaths} kills, ${result.failed.length} with a problem`)
process.exit(result.failed.length > 0 || result.runs !== runs ? 1 : 0)
