import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FakeHost, FakeRegistry } from '@fixlane/fakes'
import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { Daemon } from '../../../bench/daemon.ts'
import { writeRepo } from '../../../bench/lab.ts'
import { PACKAGES, TICKETS } from '../../../bench/suite.ts'

/** The real daemon and the real app, on synthetic repositories. */
export class Desk {
  readonly root = mkdtempSync(join(tmpdir(), 'fl-'))
  host!: FakeHost
  daemon!: Daemon
  app!: ElectronApplication
  page!: Page
  readonly #registry = new FakeRegistry(PACKAGES)

  static async open(only: string[]): Promise<Desk> {
    const d = new Desk()
    d.host = await new FakeHost(join(d.root, 'h')).listen()
    await d.#registry.listen()
    const defs = TICKETS.filter((t) => only.includes(t.ticket.id))
    const names = [...new Set(defs.map((t) => t.ticket.repo))]
    for (const name of names) {
      writeRepo(join(d.root, 'src', name), name, d.#registry)
      d.host.create(`acme/${name}`, join(d.root, 'src', name))
    }
    d.daemon = new Daemon(join(d.root, 'd'), {
      github: { url: d.host.githubApi, git: `${d.host.origin}/git/{project}.git`, token: d.host.token },
      repos: names.map((name) => ({ name, host: 'github', project: `acme/${name}`, mode: 'pr' })),
      registry: d.#registry.origin,
      rounds: 1,
      pollMs: 200,
    })
    if (!(await d.daemon.start({ FIXLANE_USER: 'sam' }))) throw new Error(d.daemon.log)
    for (const t of defs) {
      await d.daemon.call('POST', '/v1/tickets', t.ticket)
      await d.daemon.call('POST', `/v1/tickets/${t.ticket.id}/replay`, t.steps)
    }
    await d.launch()
    return d
  }

  async launch(): Promise<void> {
    this.app = await _electron.launch({
      args: [
        join(import.meta.dirname, '..'),
        ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
        `--user-data-dir=${join(this.root, 'profile')}`,
      ],
      env: { ...process.env, FIXLANE_SOCKET: join(this.root, 'd', 'sock') } as Record<string, string>,
    })
    this.page = await this.app.firstWindow()
  }

  replay(id: string, steps: unknown[]): Promise<unknown> {
    return this.daemon.call('POST', `/v1/tickets/${id}/replay`, steps)
  }

  async close(): Promise<void> {
    await this.app.close().catch(() => {})
    for (const t of (await this.daemon.state()).tickets) {
      if (t.local && t.state !== 'done' && t.state !== 'stopped')
        await this.daemon.call('POST', `/v1/sessions/${t.local.id}/cancel`, {})
    }
    await new Promise((r) => setTimeout(r, 500))
    await this.daemon.kill('SIGTERM')
    this.host.close()
    this.#registry.close()
    rmSync(this.root, { recursive: true, force: true })
  }
}

export const steps = (id: string): object[] => TICKETS.find((t) => t.ticket.id === id)!.steps
