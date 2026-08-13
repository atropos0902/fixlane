import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { Repo } from '@fixlane/core'
import { Mirror } from '@fixlane/gitstore'
import { type GitHost, GitHub, GitLab } from '@fixlane/hosts'
import { DockerSandbox } from '@fixlane/sandbox'
import { SyncClient } from '@fixlane/sync'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { Api, type StateView } from './api.ts'
import { type Coordinator, LocalBoard, LocalCoordinator, SyncCoordinator } from './coordinator.ts'
import { Engine } from './engine.ts'
import { Store } from './store.ts'
import { startTelemetry } from './telemetry.ts'

const Host = z.object({
  /** API address */
  url: z.string(),
  /** where to push, with {project} in it */
  git: z.string(),
  user: z.string().default('x-access-token'),
  token: z.string(),
})
const Upstream = z.string().optional()
const Config = z.object({
  dir: z.string().default(join(homedir(), '.local/state/fixlane')),
  registry: z.string().default('https://registry.npmjs.org'),
  github: Host.optional(),
  gitlab: Host.optional(),
  repos: z.array(Repo).default([]),
  sync: z.object({ url: z.string(), token: z.string() }).optional(),
  anthropicUrl: Upstream.default('https://api.anthropic.com'),
  openaiUrl: Upstream.default('https://api.openai.com'),
  models: z.record(z.string(), z.string()).default({}),
  prices: z.record(z.string(), z.object({ in: z.number(), out: z.number() })).default({}),
  budget: z.number().optional(),
  rounds: z.number().int().min(1).default(2),
  concurrency: z.number().int().min(1).default(3),
  pollMs: z.number().default(10_000),
  retryMs: z.number().default(500),
  heartbeatMs: z.number().default(20_000),
  minFreeMb: z.number().default(500),
})

const path = process.argv[2] ?? join(homedir(), '.config/fixlane.json')
const c = Config.parse(JSON.parse(readFileSync(path, 'utf8')))
// A socket's path may be about 100 bytes long, and ours end in /s/<session>/net/packages.sock.
if (Buffer.byteLength(c.dir) > 60) {
  console.error(`${c.dir} is too long a path, sockets go below it`)
  process.exit(1)
}
mkdirSync(c.dir, { recursive: true, mode: 0o700 })

// One daemon per directory. The lock goes when the process does, however that happens.
const lock = new Database(join(c.dir, 'lock'))
try {
  lock.pragma('locking_mode = EXCLUSIVE')
  lock.exec('BEGIN EXCLUSIVE')
} catch {
  console.error(`a daemon is already running in ${c.dir}`)
  process.exit(1)
}

/** For the crash tests: die at the named point, the nth time it is reached. */
const [killAt, killNth] = (process.env.FIXLANE_KILL_AT ?? '').split('#')
let reached = 0
const fault = (point: string): void => {
  if (killAt && point === killAt && ++reached === Number(killNth ?? 1)) process.kill(process.pid, 'SIGKILL')
}

const stopTelemetry = startTelemetry()
const store = new Store(join(c.dir, 'db'), fault)
for (const r of c.repos) if (!store.repo(r.name)) store.putRepo(r)

const ownerFile = join(c.dir, 'owner')
let owner: string
try {
  owner = readFileSync(ownerFile, 'utf8')
} catch {
  owner = crypto.randomUUID().slice(0, 8)
  writeFileSync(ownerFile, owner)
}

const hosts: Record<string, GitHost> = {}
if (c.github) hosts.github = new GitHub({ ...c.github, hookSecret: '' })
if (c.gitlab) hosts.gitlab = new GitLab({ ...c.gitlab, hookSecret: '' })

let coordinator: Coordinator = new LocalCoordinator(store, hosts)
let board: LocalBoard | null = null
let client: SyncClient | null = null
if (c.sync) {
  board = new LocalBoard(store)
  client = new SyncClient(c.sync.url, c.sync.token, board)
  coordinator = new SyncCoordinator(client, board, store)
}

const key = (name: string, url: string | undefined, header: (k: string) => Record<string, string>) => {
  const k = process.env[name]
  return k && url ? { url, headers: header(k) } : null
}
const anthropic = key('ANTHROPIC_API_KEY', c.anthropicUrl, (k) => ({ 'x-api-key': k }))
const openai = key('OPENAI_API_KEY', c.openaiUrl, (k) => ({ authorization: `Bearer ${k}` }))

const engine = new Engine({
  store,
  sandbox: new DockerSandbox({ owner }),
  coordinator,
  mirror: (r) => {
    const h = c[r.host]
    if (!h) throw new Error(`no ${r.host} in the configuration`)
    const url = h.git.replace('{project}', r.project)
    return new Mirror(join(c.dir, 'm', `${r.name}.git`), { url, user: h.user, token: h.token })
  },
  dir: c.dir,
  registry: c.registry,
  anthropic,
  openai,
  models: c.models,
  prices: c.prices,
  rounds: c.rounds,
  concurrency: c.concurrency,
  pollMs: c.pollMs,
  retryMs: c.retryMs,
  heartbeatMs: c.heartbeatMs,
  minFreeBytes: c.minFreeMb * 1024 * 1024,
  ...(c.budget ? { budget: c.budget } : {}),
})

const runtimes: StateView['runtimes'] = ['replay']
if (openai) runtimes.unshift('codex')
if (anthropic) runtimes.unshift('claude')

const api = new Api({
  engine,
  coordinator,
  board,
  client,
  me: process.env.FIXLANE_USER ?? userInfo().username,
  runtimes,
})
client?.on('entries', (es) => {
  for (const e of es) if (e.type === 'pull.changed') engine.nudge(e.ticket)
})
client?.connect()
await engine.recover()
const socket = join(c.dir, 'sock')
await api.listen(socket)
console.log(`listening on ${socket}`)

for (const s of ['SIGINT', 'SIGTERM'] as const) {
  process.once(s, () => {
    api.close()
    client?.disconnect()
    void engine
      .close()
      .then(stopTelemetry)
      .then(() => process.exit(0))
  })
}
