import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Repo, Ticket } from '@fixlane/core'
import {
  Engine,
  type EngineOptions,
  LocalCoordinator,
  type Runtime,
  type Session,
  Store,
} from '@fixlane/daemon'
import { FakeHost, FakeRegistry } from '@fixlane/fakes'
import { Mirror } from '@fixlane/gitstore'
import { GitHub, GitLab } from '@fixlane/hosts'
import { DockerSandbox } from '@fixlane/sandbox'
import { PACKAGES, REPOS, type TicketDef } from './suite.ts'

/** Writes a repository's files, with a lockfile that starts at the oldest, affected version of everything. */
export function writeRepo(dir: string, name: string, registry: FakeRegistry): void {
  const def = REPOS[name]!
  const pkg = {
    name,
    version: '1.0.0',
    private: true,
    type: 'module',
    ...(def.deps ? { dependencies: def.deps } : {}),
  }
  const files: Record<string, string> = {
    ...def.files,
    '.gitignore': 'node_modules/\n',
    'package.json': `${JSON.stringify(pkg, null, 2)}\n`,
  }
  if (def.deps) {
    const packages: Record<string, object> = { '': pkg }
    const add = (dep: string): void => {
      const [version, contents] = Object.entries(PACKAGES[dep]!)[0]!
      const { dependencies } = JSON.parse(contents['package.json'] ?? '{}') as {
        dependencies?: Record<string, string>
      }
      packages[`node_modules/${dep}`] = {
        version,
        resolved: `${registry.origin}/${dep}/-/${dep}-${version}.tgz`,
        integrity: registry.integrity(dep, version),
        ...(dependencies ? { dependencies } : {}),
      }
      for (const d of Object.keys(dependencies ?? {})) add(d)
    }
    for (const d of Object.keys(def.deps)) add(d)
    files['package-lock.json'] =
      `${JSON.stringify({ name, version: '1.0.0', lockfileVersion: 3, requires: true, packages }, null, 2)}\n`
  }
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true })
    writeFileSync(join(dir, f), t)
  }
}

export class Lab {
  readonly root = mkdtempSync(join(tmpdir(), 'fl-'))
  host!: FakeHost
  registry!: FakeRegistry
  store!: Store
  engine!: Engine
  box!: DockerSandbox

  static async make(o: Partial<EngineOptions> = {}): Promise<Lab> {
    const lab = new Lab()
    lab.host = await new FakeHost(join(lab.root, 'h')).listen()
    lab.registry = await new FakeRegistry(PACKAGES).listen()
    lab.store = new Store(join(lab.root, 'db'))
    let n = 0
    for (const name of Object.keys(REPOS)) {
      const src = join(lab.root, 'src', name)
      writeRepo(src, name, lab.registry)
      lab.host.create(`acme/${name}`, src)
      // Every other one lives on GitLab.
      lab.store.putRepo(
        Repo.parse({ name, host: n++ % 2 === 0 ? 'github' : 'gitlab', project: `acme/${name}`, mode: 'pr' }),
      )
    }
    const { token, hookSecret } = lab.host
    lab.box = new DockerSandbox({ owner: `lab-${process.pid}` })
    lab.engine = new Engine({
      store: lab.store,
      sandbox: lab.box,
      coordinator: new LocalCoordinator(lab.store, {
        github: new GitHub({ url: lab.host.githubApi, token, hookSecret }),
        gitlab: new GitLab({ url: lab.host.gitlabUrl, token, hookSecret }),
      }),
      mirror: (r) =>
        new Mirror(join(lab.root, 'm', `${r.name}.git`), {
          url: lab.host.gitUrl(r.project),
          user: 'x',
          token,
        }),
      dir: lab.root,
      registry: lab.registry.origin,
      pollMs: 60_000,
      retryMs: 100,
      ...o,
    })
    await lab.engine.recover()
    return lab
  }

  run(d: TicketDef, runtime: Runtime, id = d.ticket.id): Promise<Session> {
    const t = Ticket.parse({ ...d.ticket, id })
    this.store.putTicket(t)
    if (runtime === 'replay') this.store.putReplay(t.id, d.steps)
    return this.engine.settled(this.engine.submit(t, runtime).id)
  }

  /** Runs a ticket's own check on the branch, away from the tests the agent wrote. */
  probe(d: TicketDef, s: Session): string {
    const dir = join(this.root, 'probe', s.id)
    mkdirSync(dir, { recursive: true })
    const m = join(this.root, 'm', `${s.repo}.git`)
    execFileSync('sh', ['-c', `git -C ${m} archive ${s.head} | tar -x -C ${dir}`])
    writeFileSync(join(dir, 'probe.mjs'), d.probe!)
    try {
      const args = [
        'run',
        '--rm',
        '--network',
        'none',
        '-v',
        `${dir}:/work:ro`,
        'fixlane-check:dev',
        'timeout',
        '20',
        'node',
        'probe.mjs',
      ]
      return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    } catch (e) {
      return `failed: ${(e as { stderr?: string }).stderr?.slice(0, 200)}`
    }
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
