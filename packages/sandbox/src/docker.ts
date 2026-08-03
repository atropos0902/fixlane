import { randomUUID } from 'node:crypto'
import { chown, lchown, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { type RunnerLine, RunnerLine as RunnerLineSchema, type TestResult, type TestRun } from '@fixlane/core'
import { api, DockerError, enc, exec, inspect, list, logs, remove } from './engine.ts'

export interface AgentRun {
  name: string
  session: string
  workspace: string
  objects: string
  sessionDir: string
}

export interface TestJob {
  session: string
  tree: string
}

export interface AgentExit {
  lines: RunnerLine[]
  /** false when the container went away without the runner's last line */
  finished: boolean
}

/** What the engine needs from a place to run agents and tests. */
export interface Sandbox {
  /** Where an agent finds the mirror's objects. Null when that is where they are on this machine. */
  readonly objectsAs: string | null
  prepare(dir: string): Promise<void>
  startAgent(run: AgentRun): Promise<void>
  /** Every line from the first one on, so that following again after a restart loses nothing. */
  follow(name: string, onLine: (line: RunnerLine, n: number) => void): Promise<AgentExit>
  harvest(run: AgentRun, base: string): Promise<Buffer | null>
  test(job: TestJob): Promise<TestRun>
  install(job: TestJob & { net: string }): Promise<{ ok: boolean; log: string }>
  stop(name: string): Promise<void>
  pause(name: string): Promise<void>
  resume(name: string): Promise<void>
  /** Removes everything that belongs to a session, except containers named in `keep`. */
  clear(session: string, keep?: readonly string[]): Promise<void>
  sessions(): Promise<string[]>
}

export interface DockerOptions {
  /** Marks this daemon's containers, so that two daemons on one machine leave each other alone. */
  owner: string
  agentImage?: string
  checkImage?: string
  testTimeoutMs?: number
}

const asRoot = process.getuid?.() === 0
const UID = asRoot ? 1000 : (process.getuid?.() ?? 1000)
const GID = asRoot ? 1000 : (process.getgid?.() ?? 1000)

const NPM = ['npm_config_registry=http://127.0.0.1:4802', 'npm_config_replace_registry_host=always']

async function give(path: string): Promise<void> {
  await chown(path, UID, GID)
  for (const e of await readdir(path, { withFileTypes: true, recursive: true })) {
    await lchown(join(e.parentPath, e.name), UID, GID)
  }
}

interface Create {
  name: string
  image: string
  cmd: string[]
  binds: string[]
  labels: Record<string, string>
  env?: string[]
}

export class DockerSandbox implements Sandbox {
  // Not the path they have here: below /root, say, the agent's user could not get to it.
  readonly objectsAs = '/mirror/objects'
  readonly #o: Required<DockerOptions>

  constructor(o: DockerOptions) {
    this.#o = {
      agentImage: 'fixlane-agent:dev',
      checkImage: 'fixlane-check:dev',
      testTimeoutMs: 120_000,
      ...o,
    }
  }

  async prepare(dir: string): Promise<void> {
    if (asRoot) await give(dir)
  }

  async #create(c: Create): Promise<void> {
    await api('POST', `/containers/create?name=${enc(c.name)}`, {
      Image: c.image,
      // Docker's own init would do, but it can be read, and so its output can be written to from inside.
      Entrypoint: ['/usr/bin/tini', '--'],
      Cmd: c.cmd,
      User: `${UID}:${GID}`,
      WorkingDir: '/work',
      Env: ['HOME=/home/agent', 'npm_config_update_notifier=false', ...(c.env ?? [])],
      Labels: { 'fixlane.owner': this.#o.owner, ...c.labels },
      HostConfig: {
        Binds: c.binds,
        NetworkMode: 'none',
        ReadonlyRootfs: true,
        Tmpfs: { '/tmp': 'rw,exec,size=256m', '/home/agent': `rw,exec,size=512m,uid=${UID},gid=${GID}` },
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: 512,
        Memory: 2 * 1024 ** 3,
        NanoCpus: 2e9,
        LogConfig: { Type: 'json-file', Config: { 'max-size': '50m' } },
      },
    })
  }

  async startAgent(run: AgentRun): Promise<void> {
    try {
      await this.#create({
        name: run.name,
        image: this.#o.agentImage,
        cmd: ['node', '/opt/runner/main.ts'],
        // Only the objects of the mirror: its refs, config and remote stay out of reach.
        binds: [
          `${run.workspace}:/work`,
          `${run.objects}:${this.objectsAs}:ro`,
          `${run.sessionDir}:/session:ro`,
        ],
        labels: { 'fixlane.session': run.session, 'fixlane.kind': 'agent' },
        env: NPM,
      })
    } catch (e) {
      // Already made, by us, before a crash.
      if (!(e instanceof DockerError && e.status === 409)) throw e
    }
    const i = await inspect(run.name)
    if (i?.State.Status === 'created') await api('POST', `/containers/${enc(run.name)}/start`)
  }

  async follow(name: string, onLine: (line: RunnerLine, n: number) => void): Promise<AgentExit> {
    const lines: RunnerLine[] = []
    for await (const raw of logs(name, true)) {
      let line: RunnerLine
      try {
        line = RunnerLineSchema.parse(JSON.parse(raw))
      } catch {
        continue // something the agent printed past the runner
      }
      onLine(line, lines.length)
      lines.push(line)
    }
    // A forged end line in the middle does not count. The last one does.
    return { lines, finished: lines.at(-1)?.t === 'end' }
  }

  async harvest(run: AgentRun, base: string): Promise<Buffer | null> {
    const name = `${run.name}-harvest`
    await remove(name)
    await remove(run.name)
    const out = await this.#once({
      name,
      image: this.#o.checkImage,
      cmd: ['sh', '/opt/check/harvest.sh', base],
      binds: [`${run.workspace}:/work`, `${run.objects}:${this.objectsAs}:ro`],
      labels: { 'fixlane.session': run.session, 'fixlane.kind': 'harvest' },
    })
    if (out.exit === 3) return null
    if (out.exit !== 0) throw new Error(`could not collect the branch (exit ${out.exit})`)
    return Buffer.from(out.stdout, 'base64')
  }

  async test(job: TestJob): Promise<TestRun> {
    const out = await this.#once({
      name: `fixlane-test-${randomUUID()}`,
      image: this.#o.checkImage,
      cmd: [
        'node',
        '--test',
        '--test-reporter=/opt/check/reporter.mjs',
        '--test-reporter-destination=stdout',
      ],
      binds: [`${job.tree}:/work:ro`],
      labels: { 'fixlane.session': job.session, 'fixlane.kind': 'check' },
    })
    const results: TestResult[] = []
    for (const l of out.stdout.split('\n')) {
      if (l === '') continue
      try {
        results.push(JSON.parse(l) as TestResult)
      } catch {
        return { results: [], exit: null }
      }
    }
    return { results, exit: out.exit }
  }

  async install(job: TestJob & { net: string }): Promise<{ ok: boolean; log: string }> {
    const bridge =
      "require('net').createServer(c=>{const s=require('net').connect('/net/packages.sock');c.pipe(s).pipe(c);c.on('error',()=>s.destroy());s.on('error',()=>c.destroy())}).listen(4802,'127.0.0.1',()=>{const p=require('child_process').spawn('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{stdio:'inherit'});p.on('exit',c=>process.exit(c??1))})"
    const out = await this.#once({
      name: `fixlane-install-${randomUUID()}`,
      image: this.#o.checkImage,
      cmd: ['node', '-e', bridge],
      binds: [`${job.tree}:/work`, `${job.net}:/net:ro`],
      labels: { 'fixlane.session': job.session, 'fixlane.kind': 'check' },
      env: NPM,
    })
    return { ok: out.exit === 0, log: out.stdout.slice(-2000) }
  }

  /** Runs a container to its end and removes it. A null exit means it was killed for taking too long. */
  async #once(c: Create): Promise<{ stdout: string; exit: number | null }> {
    await this.#create(c)
    try {
      await api('POST', `/containers/${enc(c.name)}/start`)
      let late = false
      const timer = setTimeout(() => {
        late = true
        api('POST', `/containers/${enc(c.name)}/kill`).catch(() => {})
      }, this.#o.testTimeoutMs)
      const { StatusCode } = await api<{ StatusCode: number }>('POST', `/containers/${enc(c.name)}/wait`)
      clearTimeout(timer)
      const stdout: string[] = []
      for await (const l of logs(c.name, false)) stdout.push(l)
      return { stdout: stdout.join('\n'), exit: late ? null : StatusCode }
    } finally {
      await remove(c.name)
    }
  }

  stop(name: string): Promise<void> {
    return remove(name)
  }

  /** Everything but the init process freezes. A shell started afterwards runs. */
  async pause(name: string): Promise<void> {
    // "Running" is written down a moment before there is a container.
    for (let i = 0; i < 100; i++) {
      const at = (await inspect(name))?.State.Status
      if (at && at !== 'created') break
      await new Promise((r) => setTimeout(r, 100))
    }
    await exec(name, ['sh', '-c', 'kill -STOP -1'])
  }

  async resume(name: string): Promise<void> {
    await exec(name, ['sh', '-c', 'kill -CONT -1'])
  }

  async clear(session: string, keep: readonly string[] = []): Promise<void> {
    const mine = await list({ 'fixlane.owner': this.#o.owner, 'fixlane.session': session })
    await Promise.all(
      mine.filter((c) => !c.Names.some((n) => keep.includes(n.slice(1)))).map((c) => remove(c.Id)),
    )
  }

  async sessions(): Promise<string[]> {
    const mine = await list({ 'fixlane.owner': this.#o.owner })
    return [...new Set(mine.map((c) => c.Labels['fixlane.session'] ?? ''))].filter(Boolean)
  }
}
