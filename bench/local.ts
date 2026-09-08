// Starts everything on this machine: Postgres, the sync server, a git host and a package registry that
// hold synthetic repositories, the daemon, and the desktop app if there is a screen.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Repo } from '@fixlane/core'
import { FakeHost, FakeRegistry } from '@fixlane/fakes'
import { GitHub, GitLab } from '@fixlane/hosts'
import { Db, Service, SyncServer } from '@fixlane/sync'
import { Daemon } from './daemon.ts'
import { writeRepo } from './lab.ts'
import { PACKAGES, REPOS, TICKETS } from './suite.ts'

const top = join(import.meta.dirname, '..')
const run = (cmd: string, args: string[]): void =>
  void execFileSync(cmd, args, { cwd: top, stdio: ['ignore', 'ignore', 'inherit'] })
const step = (s: string): void => console.log(s)
const dir = join(homedir(), '.local/state/fixlane-local')
const PG =
  process.env.FIXLANE_PG ??
  `postgres://fixlane:fixlane@127.0.0.1:${process.env.FIXLANE_PG_PORT ?? 55432}/fixlane`

step('images')
const image = join(top, 'packages/sandbox/image')
run('docker', ['build', '-q', '--target', 'check', '-t', 'fixlane-check:dev', image])
run('docker', ['build', '-q', '--target', 'agent', '-t', 'fixlane-agent:dev', image])

step('Postgres')
run('docker', ['compose', 'up', '-d', '--wait', '--quiet-pull'])
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
const admin = new Db(PG)
await admin.pool.query('DROP DATABASE IF EXISTS fixlane_local WITH (FORCE)')
await admin.pool.query('CREATE DATABASE fixlane_local')
await admin.close()
const url = new URL(PG)
url.pathname = '/fixlane_local'

step('git host, registry and twelve repositories')
const host = await new FakeHost(join(dir, 'host')).listen()
const registry = await new FakeRegistry(PACKAGES).listen()
for (const name of Object.keys(REPOS)) {
  writeRepo(join(dir, 'src', name), name, registry)
  host.create(`acme/${name}`, join(dir, 'src', name))
}

step('sync server')
const { token, hookSecret } = host
const users = { sam: 'local-token-of-sam-0001', kim: 'local-token-of-kim-0001' }
const hosts = {
  github: new GitHub({ url: host.githubApi, token, hookSecret }),
  gitlab: new GitLab({ url: host.gitlabUrl, token, hookSecret }),
}
const server = new SyncServer({ service: new Service(new Db(url.toString()), hosts), users, port: 0 })
await server.start()

step('daemon')
const git = { git: `${host.origin}/git/{project}.git`, token }
const daemon = new Daemon(join(dir, 'd'), {
  github: { url: host.githubApi, ...git },
  gitlab: { url: host.gitlabUrl, ...git },
  registry: registry.origin,
  sync: { url: server.origin, token: users.sam },
  pollMs: 2000,
})
if (!(await daemon.start({ FIXLANE_USER: 'sam' }))) throw new Error(daemon.log)
const names = Object.keys(REPOS)
/** Every other repository is on GitLab. */
const kindOf = (name: string): 'github' | 'gitlab' => (names.indexOf(name) % 2 ? 'gitlab' : 'github')
for (const name of names) {
  await daemon.call(
    'POST',
    '/v1/repos',
    Repo.parse({ name, host: kindOf(name), project: `acme/${name}`, mode: 'pr' }),
  )
}
for (const t of TICKETS) {
  await daemon.call('POST', '/v1/tickets', t.ticket)
  await daemon.call('POST', `/v1/tickets/${t.ticket.id}/replay`, t.steps)
}
const socket = join(dir, 'd', 'sock')
writeFileSync(
  join(dir, 'merge.sh'),
  `#!/bin/sh\n# usage: merge.sh <project> <number>\ncurl -s -X POST ${host.origin}/__/settle -d "{\\"project\\":\\"$1\\",\\"number\\":$2,\\"state\\":\\"merged\\"}"\n`,
  { mode: 0o755 },
)

console.log(`\nup. ${TICKETS.length} tickets are on the board.`)
console.log(`  desktop      FIXLANE_SOCKET=${socket} pnpm desktop`)
console.log(`  merge one    ${join(dir, 'merge.sh')} acme/ledger 1`)
console.log('  stop         Ctrl-C')
if (
  (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === 'darwin') &&
  !process.env.CI
) {
  if (!existsSync(join(top, 'apps/desktop/dist'))) run('pnpm', ['--filter', '@fixlane/desktop', 'build'])
  const as = process.getuid?.() === 0 ? ['--no-sandbox'] : []
  spawn('pnpm', ['--filter', '@fixlane/desktop', 'start', ...as], {
    cwd: top,
    stdio: 'ignore',
    env: { ...process.env, FIXLANE_SOCKET: socket },
  })
}
// The fake host sends no webhooks by itself.
const merged = new Set<string>()
setInterval(() => {
  for (const p of host.pulls) {
    const id = `${p.project}#${p.number}`
    if (p.state === 'open' || merged.has(id)) continue
    merged.add(id)
    const kind = kindOf(p.project.slice('acme/'.length))
    const { headers, body } = host.hook(kind, p)
    void fetch(`${server.origin}/hooks/${kind}`, { method: 'POST', headers, body })
  }
}, 1000)
for (const s of ['SIGINT', 'SIGTERM'] as const) {
  process.once(s, async () => {
    await daemon.kill('SIGTERM')
    await server.close()
    host.close()
    registry.close()
    run('docker', ['compose', 'down', '-v'])
    process.exit(0)
  })
}
