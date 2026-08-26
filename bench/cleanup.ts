// Kills sessions that started things in the background, half of them together with the daemon.
// usage: node bench/cleanup.ts [sessions]
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeHost } from '@fixlane/fakes'
import { Daemon, random, until } from './daemon.ts'

const count = Number(process.argv[2] ?? 200)
const root = mkdtempSync(join(tmpdir(), 'fl-'))
mkdirSync(join(root, 'src'))
writeFileSync(join(root, 'src', 'package.json'), '{"type":"module"}')
const host = await new FakeHost(join(root, 'h')).listen()
host.create('acme/depot', join(root, 'src'))
const d = new Daemon(join(root, 'd'), {
  github: { url: host.githubApi, git: `${host.origin}/git/{project}.git`, token: host.token },
  repos: [{ name: 'depot', host: 'github', project: 'acme/depot', mode: 'pr' }],
  concurrency: 4,
  pollMs: 100,
})
// An odd length makes the processes ours to find on the host.
const MARK = `86${process.pid}`
const stray = [
  {
    run: `setsid sleep ${MARK} & (setsid sh -c "trap '' TERM HUP INT; sleep ${MARK}; sleep ${MARK}" &) ; nohup sleep ${MARK} >/dev/null 2>&1 & node -e "require('child_process').spawn('sleep',['${MARK}'],{detached:true,stdio:'ignore'}).unref(); setInterval(()=>{},1e3)" & sleep ${MARK}`,
  },
]
const rnd = random(7)
let killed = 0
let withDaemon = 0
const started = Date.now()
await d.start()
for (let i = 0; i < count; ) {
  const batch = Math.min(4, count - i)
  const ids: string[] = []
  for (let n = 0; n < batch; n++, i++) {
    const id = `t-${i}`
    await d.call('POST', '/v1/tickets', { id, repo: 'depot', kind: 'code', title: 'x', body: '' })
    await d.call('POST', `/v1/tickets/${id}/replay`, stray)
    ids.push((await d.call<{ id: string }>('POST', `/v1/tickets/${id}/start`, { runtime: 'replay' })).id)
  }
  // Some are killed while they are still being made.
  await new Promise((r) => setTimeout(r, rnd() * 3000))
  if (rnd() < 0.5) {
    withDaemon += batch
    await d.kill()
    await d.start()
  }
  for (const id of ids) {
    await d.call('POST', `/v1/sessions/${id}/cancel`, {})
    killed++
  }
  await until(async () => (await d.state()).tickets.every((t) => t.state === 'stopped'), 30_000)
  process.stderr.write(`\r${killed}`)
}
await until(async () => readdirSync(join(d.dir, 'work')).length === 0, 10_000)
const owner = execFileSync('cat', [join(d.dir, 'owner')], { encoding: 'utf8' })
const containers = execFileSync('docker', ['ps', '-aq', '--filter', `label=fixlane.owner=${owner}`], {
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean).length
let processes = 0
try {
  processes = execFileSync('pgrep', ['-xf', `sleep ${MARK}`], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean).length
} catch {}
const left = ['work', 's', 'trees', 'review'].flatMap((x) => readdirSync(join(d.dir, x)))
const holds = readdirSync(join(d.dir, 'm', 'depot.git', 'holds'))
await d.kill('SIGTERM')
const result = {
  killed,
  withDaemon,
  containers,
  processes,
  directories: left.length,
  holds: holds.length,
  seconds: Math.round((Date.now() - started) / 1000),
}
writeFileSync(new URL('results/cleanup.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
console.log('\n', result)
host.close()
rmSync(root, { recursive: true, force: true })
process.exit(containers + processes + left.length + holds.length)
