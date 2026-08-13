import { chmodSync, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, rm, statfs, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { BadMove, branchName, isOver, type Repo, type SessionState, type Ticket } from '@fixlane/core'
import { GitError, type Mirror } from '@fixlane/gitstore'
import { HostError } from '@fixlane/hosts'
import type { AgentRun, Sandbox } from '@fixlane/sandbox'
import { check } from './checks.ts'
import type { Coordinator } from './coordinator.ts'
import { type Price, Proxies, type Upstream } from './proxies.ts'
import type { Runtime, Session, Store } from './store.ts'
import { traced } from './telemetry.ts'
import { prompt, pullBody, pullTitle } from './words.ts'

export interface EngineOptions {
  store: Store
  sandbox: Sandbox
  coordinator: Coordinator
  mirror: (repo: Repo) => Mirror
  /** Where workspaces, session directories and review worktrees go. Keep it short: sockets live in it. */
  dir: string
  registry: string
  anthropic?: Upstream | null
  openai?: Upstream | null
  models?: Partial<Record<Runtime, string>>
  prices?: Record<string, Price>
  budget?: number
  rounds?: number
  concurrency?: number
  heartbeatMs?: number
  pollMs?: number
  retryMs?: number
  /** Clones, agents and checks wait while less than this is free. */
  minFreeBytes?: number
  free?: () => Promise<number>
}

class NoRoom extends Error {}

/** Somebody we depend on is away. Waiting is the right answer, however long it takes. */
export function isOutage(e: unknown): boolean {
  if (e instanceof NoRoom) return true
  if (e instanceof HostError) return e.status === null || e.status >= 500 || e.status === 429
  if (e instanceof GitError)
    return /could not resolve|failed to connect|unable to access|timed out|no space left/i.test(e.stderr)
  const { name, message, code } = e as { name?: string; message?: string; code?: string }
  if (['ECONNREFUSED', 'ENOENT', 'ECONNRESET', 'EPIPE', 'ENOSPC', 'SQLITE_FULL'].includes(code ?? ''))
    return true
  return name === 'TimeoutError' || message === 'fetch failed'
}

const TRIES = 8
const WORKING: readonly SessionState[] = ['cloning', 'running', 'checking']
const LEASED: readonly SessionState[] = ['cloning', 'running', 'checking', 'proposing']

/**
 * Drives each session through its states. The state on disk says what was about to happen, never what
 * did happen, so every step first looks at the world and can be run again from its start.
 */
export class Engine {
  readonly #o: Required<EngineOptions>
  readonly #live = new Map<string, Promise<void>>()
  readonly #mirrors = new Map<string, Promise<Mirror>>()
  readonly #proxies = new Map<string, Proxies>()
  readonly #wake = new Map<string, () => void>()
  readonly #beats = new Map<string, NodeJS.Timeout>()
  #slots: number
  readonly #waiting: (() => void)[] = []
  #closed = false

  constructor(o: EngineOptions) {
    this.#o = {
      anthropic: null,
      openai: null,
      models: {},
      prices: {},
      budget: 3_000_000,
      rounds: 2,
      concurrency: 3,
      heartbeatMs: 20_000,
      pollMs: 10_000,
      retryMs: 500,
      minFreeBytes: 500 * 1024 * 1024,
      free: async () => {
        const s = await statfs(o.dir)
        return s.bavail * s.bsize
      },
      ...o,
    }
    this.#slots = this.#o.concurrency
  }

  get store(): Store {
    return this.#o.store
  }

  async mirror(repo: Repo): Promise<Mirror> {
    let m = this.#mirrors.get(repo.name)
    if (!m) {
      m = (async () => {
        const mirror = this.#o.mirror(repo)
        await mirror.open()
        return mirror
      })()
      this.#mirrors.set(repo.name, m)
    }
    return m
  }

  /** Picks up where the last daemon stopped, and clears away what nobody owns any more. */
  async recover(): Promise<void> {
    for (const d of ['work', 's', 'trees', 'review']) await mkdir(join(this.#o.dir, d), { recursive: true })
    const open = new Map(this.store.open().map((s) => [s.id, s]))
    for (const id of await this.#o.sandbox.sessions()) {
      const s = open.get(id)
      // Check and harvest containers are started afresh. An agent that is still at work is left alone.
      await this.#o.sandbox.clear(id, s?.state === 'running' ? [this.#container(s)] : [])
    }
    await this.#sweep()
    for (const s of open.values()) {
      // Whoever was typing in there is gone with the old daemon.
      if (s.paused) await this.resume(s.id).catch(() => this.store.set(s.id, { paused: false }))
      this.start(s.id)
    }
  }

  /** Removes directories and holds that belong to no working session. */
  async #sweep(): Promise<void> {
    const busy = new Set(
      this.store
        .open()
        .filter((s) => WORKING.includes(s.state))
        .map((s) => s.id),
    )
    const idOf = (name: string): string => name.split('-')[0] ?? ''
    for (const d of ['work', 's', 'trees']) {
      for (const name of await readdir(join(this.#o.dir, d))) {
        if (!busy.has(idOf(name))) await rm(join(this.#o.dir, d, name), { recursive: true, force: true })
      }
    }
    for (const repo of this.store.repos()) {
      const m = await this.mirror(repo)
      for (const hold of await m.holds()) if (!busy.has(hold)) await m.release(hold)
    }
    // A worktree outlives its session when the daemon dies between the last move and tidying up.
    const wanted = new Set(this.store.open().map((s) => s.ticket))
    for (const ticket of await readdir(join(this.#o.dir, 'review'))) {
      if (wanted.has(ticket)) continue
      const repo = this.store.repo(this.store.ticket(ticket)?.repo ?? '')
      if (repo) await (await this.mirror(repo)).removeWorktree(join(this.#o.dir, 'review', ticket))
    }
  }

  submit(ticket: Ticket, runtime: Runtime): Session {
    const s = this.store.newSession(ticket, runtime)
    this.start(s.id)
    return s
  }

  /** Takes a ticket from whoever has it and works on it here. */
  async moveHere(ticket: Ticket, runtime: Runtime): Promise<Session> {
    const s = this.store.newSession(ticket, runtime)
    const r = await this.#o.coordinator.take(ticket.id, s.id, true)
    if ('heldBy' in r) this.store.move(s.id, { type: 'cancelled', by: `the server: ${r.heldBy} has it` })
    this.start(s.id)
    return this.store.session(s.id)!
  }

  start(id: string): void {
    if (this.#live.has(id) || this.#closed) return
    const p = this.#drive(id)
      .catch((e: Error) => {
        if (!this.#closed) this.#note(id, `stuck: ${e.message}`)
      })
      .finally(() => this.#live.delete(id))
    this.#live.set(id, p)
  }

  /** Resolves when the session is over or waits for a reviewer. */
  async settled(id: string): Promise<Session> {
    for (;;) {
      const s = this.store.session(id)!
      if (s.state === 'in_review' || (isOver(s.state) && !this.#live.has(id))) return s
      await new Promise<void>((r) => {
        const done = (): void => {
          this.store.off('session', done)
          r()
        }
        this.store.on('session', done)
        setTimeout(done, 100)
      })
    }
  }

  async close(): Promise<void> {
    this.#closed = true
    for (const t of this.#beats.values()) clearInterval(t)
    for (const w of this.#wake.values()) w()
    for (const p of this.#proxies.values()) p.close()
    for (const w of this.#waiting.splice(0)) w()
  }

  #container(s: Session): string {
    return `fixlane-${s.id}-${s.attempt}`
  }
  #run(s: Session, m: Mirror): AgentRun {
    return {
      name: this.#container(s),
      session: s.id,
      workspace: join(this.#o.dir, 'work', `${s.id}-${s.attempt}`),
      objects: m.objects,
      sessionDir: join(this.#o.dir, 's', s.id),
    }
  }
  reviewDir(s: Session): string {
    return join(this.#o.dir, 'review', s.ticket)
  }
  #branch(s: Session): string {
    return branchName(s.ticket, s.epoch!)
  }
  #fault(point: string): void {
    this.store.fault(point)
  }

  async #slot(): Promise<() => void> {
    if (this.#slots > 0) this.#slots--
    else await new Promise<void>((r) => this.#waiting.push(r))
    let given = false
    return () => {
      if (given) return
      given = true
      const next = this.#waiting.shift()
      if (next) next()
      else this.#slots++
    }
  }

  async #drive(id: string): Promise<void> {
    let free: (() => void) | null = null
    let misses = 0
    try {
      for (;;) {
        const s = this.store.session(id)!
        if (this.#closed) return
        this.#beat(s)
        if (!WORKING.includes(s.state)) {
          await this.#tidy(s)
          free?.()
          free = null
        }
        if (isOver(s.state)) return
        if (WORKING.includes(s.state) && !free) free = await this.#slot()
        if (this.#closed) return
        try {
          await traced(`session ${s.state}`, { session: s.id, ticket: s.ticket, attempt: s.attempt }, () =>
            this.#step(s),
          )
          misses = 0
        } catch (e) {
          if (this.#closed) return
          const now = this.store.session(id)!
          // Somebody else moved it on while we were busy (a cancel, a lost lease). What we did is void.
          if (e instanceof BadMove || now.state !== s.state || now.attempt !== s.attempt) continue
          misses++
          if (misses >= TRIES && !isOutage(e)) {
            this.store.move(id, {
              type: 'cancelled',
              by: `the daemon, as ${s.state} keeps failing: ${(e as Error).message}`,
            })
            continue
          }
          this.#note(id, `will try again: ${(e as Error).message}`)
          await this.#nap(id, Math.min(this.#o.retryMs * 2 ** misses, 30_000))
        }
      }
    } finally {
      free?.()
      this.#stopBeat(id)
    }
  }

  /** A note is a courtesy. Not being able to write one, on a full disk say, must not end anything. */
  #note(id: string, note: string): void {
    try {
      this.store.set(id, { note })
    } catch {}
  }

  /** Sleeps, unless the session changes first. */
  async #nap(id: string, ms: number): Promise<void> {
    const stop = new AbortController()
    this.#wake.set(id, () => stop.abort())
    await sleep(ms, undefined, { signal: stop.signal }).catch(() => {})
    this.#wake.delete(id)
  }

  #beat(s: Session): void {
    const needed = LEASED.includes(s.state)
    if (!needed) return this.#stopBeat(s.id)
    if (this.#beats.has(s.id)) return
    this.#beats.set(
      s.id,
      setInterval(() => void this.#renew(s.id), this.#o.heartbeatMs),
    )
  }
  #stopBeat(id: string): void {
    clearInterval(this.#beats.get(id))
    this.#beats.delete(id)
  }
  async #renew(id: string): Promise<void> {
    const s = this.store.session(id)!
    if (!LEASED.includes(s.state)) return
    try {
      if (await this.#o.coordinator.renew(s.ticket, s.epoch!)) return
    } catch {
      return // offline. The epoch protects the ticket until we are back.
    }
    await this.#interrupt(id, () => this.store.move(id, { type: 'lease.lost' }))
  }

  /** Moves a session on from outside its own loop, then pulls whatever it is waiting for from under it. */
  async #interrupt(id: string, move: () => void): Promise<void> {
    try {
      move()
    } catch (e) {
      if (e instanceof BadMove) return
      throw e
    }
    this.#wake.get(id)?.()
    await this.#o.sandbox.clear(id)
    this.start(id)
  }

  async cancel(id: string, by: string): Promise<void> {
    await this.#interrupt(id, () => this.store.move(id, { type: 'cancelled', by }))
  }

  async pause(id: string): Promise<string> {
    const s = this.store.session(id)
    if (s?.state !== 'running') throw new Error('only a running session can be taken over')
    await this.#o.sandbox.pause(this.#container(s))
    this.store.set(id, { paused: true })
    return this.#container(s)
  }
  async resume(id: string): Promise<void> {
    const s = this.store.session(id)
    if (s?.state !== 'running') return
    await this.#o.sandbox.resume(this.#container(s))
    this.store.set(id, { paused: false })
  }

  /** What a session leaves behind once the agent and the checks are through with it. */
  async #tidy(s: Session): Promise<void> {
    this.#proxies.get(s.id)?.close()
    this.#proxies.delete(s.id)
    await this.#o.sandbox.clear(s.id)
    for (const d of ['work', 's', 'trees']) {
      const dir = join(this.#o.dir, d)
      if (!existsSync(dir)) continue
      for (const name of await readdir(dir)) {
        if (name === s.id || name.startsWith(`${s.id}-`))
          await rm(join(dir, name), { recursive: true, force: true })
      }
    }
    const m = await this.mirror(this.store.repo(s.repo)!)
    await m.release(s.id)
    if (isOver(s.state)) {
      await m.removeWorktree(this.reviewDir(s))
      if (s.epoch !== null) await this.#o.coordinator.release(s.ticket, s.epoch).catch(() => {})
      this.#fault('tidied')
    }
  }

  async #step(s: Session): Promise<void> {
    const repo = this.store.repo(s.repo)
    const ticket = this.store.ticket(s.ticket)
    if (!repo || !ticket) throw new Error(`no ticket or repository for session ${s.id}`)
    const m = await this.mirror(repo)
    // An agent that runs into a full disk has wasted its attempt, so none of this begins on one.
    if (WORKING.includes(s.state) && (await this.#o.free()) < this.#o.minFreeBytes) {
      throw new NoRoom('there is hardly any disk space')
    }
    switch (s.state) {
      case 'queued':
        return this.#lease(s)
      case 'cloning':
        return this.#clone(s, repo, ticket, m)
      case 'running':
        return this.#agent(s, ticket, m)
      case 'checking':
        return this.#check(s, ticket, m)
      case 'proposing':
        return this.#propose(s, repo, ticket, m)
      case 'in_review':
        return this.#review(s, m)
    }
  }

  async #lease(s: Session): Promise<void> {
    const r = await this.#o.coordinator.take(s.ticket, s.id)
    this.#fault('leased')
    if ('heldBy' in r) {
      this.store.set(s.id, { note: `${r.heldBy} has this ticket` })
      await this.#nap(s.id, this.#o.pollMs)
      return
    }
    this.store.move(s.id, { type: 'leased', epoch: r.epoch })
  }

  async #clone(s: Session, repo: Repo, ticket: Ticket, m: Mirror): Promise<void> {
    await this.#o.sandbox.clear(s.id)
    const run = this.#run(s, m)
    // The base stays what it was for the first attempt, so that two attempts can be compared.
    const base = s.base ?? (await m.fetchBase(repo.base))
    const objectsAs = this.#o.sandbox.objectsAs
    await m.clone({ session: s.id, dest: run.workspace, base, branch: this.#branch(s), objectsAs })
    this.#fault('cloned')
    await chmod(run.workspace, 0o755)
    await this.#o.sandbox.prepare(run.workspace)
    await mkdir(join(run.sessionDir, 'net'), { recursive: true })
    await writeFile(
      join(run.sessionDir, 'spec.json'),
      JSON.stringify({
        runtime: s.runtime,
        prompt: prompt(ticket, s.feedback),
        model: this.#o.models[s.runtime],
      }),
    )
    // The key's hash stays out of it: the agent has to find the key, and does not need to know more.
    await writeFile(join(run.sessionDir, 'ticket.json'), JSON.stringify({ ...ticket, key: undefined }))
    const steps = this.store.replay(s.ticket)
    if (steps) await writeFile(join(run.sessionDir, 'replay.json'), steps)
    this.#fault('prepared')
    this.store.move(s.id, { type: 'cloned' }, { base })
  }

  async #openProxies(s: Session, ticket: Ticket, m: Mirror, run: AgentRun): Promise<void> {
    if (this.#proxies.has(s.id)) return
    const names = new Set<string>(ticket.advisory ? [ticket.advisory.package] : [])
    for (const f of ['package-lock.json', 'package.json']) {
      try {
        const j = JSON.parse((await m.show(s.base!, f)) ?? '{}') as Record<string, Record<string, unknown>>
        for (const p of Object.keys(j.packages ?? {})) names.add(p.slice(p.lastIndexOf('node_modules/') + 13))
        for (const k of ['dependencies', 'devDependencies'])
          for (const n of Object.keys(j[k] ?? {})) names.add(n)
      } catch {}
    }
    names.delete('')
    chmodSync(run.sessionDir, 0o755)
    const p = await Proxies.open({
      dir: join(run.sessionDir, 'net'),
      anthropic: this.#o.anthropic,
      openai: this.#o.openai,
      registry: this.#o.registry,
      packages: names,
      budget: this.#o.budget,
      prices: this.#o.prices,
      spent: () => {
        const now = this.store.session(s.id)!
        return now.tokensIn + now.tokensOut
      },
      onUsage: (i, o, c) => this.store.spend(s.id, i, o, c),
    })
    this.#proxies.set(s.id, p)
  }

  async #agent(s: Session, ticket: Ticket, m: Mirror): Promise<void> {
    const run = this.#run(s, m)
    await this.#openProxies(s, ticket, m, run)
    await this.#o.sandbox.startAgent(run)
    this.#fault('agent started')
    // Cancelled while the container was being made: whoever did that cleared up before there was one.
    if (this.store.session(s.id)!.state !== 'running') {
      await this.#o.sandbox.clear(s.id)
      return
    }
    const exit = await this.#o.sandbox.follow(run.name, (line, n) =>
      this.store.addLine(s.id, s.attempt, n, line),
    )
    if (this.#closed) return
    const now = this.store.session(s.id)!
    if (now.state !== 'running' || now.attempt !== s.attempt) return
    this.#fault('agent ended')
    this.store.set(s.id, { paused: false })
    this.#proxies.get(s.id)?.close()
    this.#proxies.delete(s.id)
    const stop = exit.lines.find((l) => l.t === 'stop')
    const end = exit.lines.at(-1)
    if (stop)
      this.store.move(s.id, {
        type: 'agent.stopped',
        reason: stop.reason.slice(0, 1000) || 'no reason given',
      })
    else if (!exit.finished) this.store.move(s.id, { type: 'agent.failed', error: 'the container went away' })
    else if (end?.t === 'end' && !end.ok)
      this.store.move(s.id, { type: 'agent.failed', error: end.error ?? 'unknown' })
    else this.store.move(s.id, { type: 'agent.finished' })
  }

  async #check(s: Session, ticket: Ticket, m: Mirror): Promise<void> {
    const bundle = await this.#o.sandbox.harvest(this.#run(s, m), s.base!)
    this.#fault('harvested')
    if (bundle === null) {
      this.store.move(s.id, { type: 'checks.failed', why: 'the branch changes nothing', retry: true })
      return
    }
    let head: string
    try {
      head = await m.importBundle(
        bundle,
        s.base!,
        this.#branch(s),
        `${pullTitle(ticket)}\n\nTicket: ${ticket.id}`,
      )
    } catch (e) {
      this.store.move(s.id, {
        type: 'checks.failed',
        why: `the branch cannot be read: ${(e as Error).message}`,
        retry: true,
      })
      return
    }
    this.#fault('imported')
    const verdict = await check({
      mirror: m,
      sandbox: this.#o.sandbox,
      ticket,
      session: s.id,
      base: s.base!,
      head,
      dir: join(this.#o.dir, 'trees', s.id),
      registry: this.#o.registry,
      rounds: this.#o.rounds,
    })
    const now = this.store.session(s.id)!
    if (this.#closed || now.state !== 'checking' || now.attempt !== s.attempt) return
    this.store.putVerdict(s.id, s.attempt, verdict)
    if (verdict.ok) this.store.move(s.id, { type: 'checks.passed' }, { head })
    else this.store.move(s.id, { type: 'checks.failed', why: verdict.why, retry: verdict.retry }, { head })
  }

  async #propose(s: Session, repo: Repo, ticket: Ticket, m: Mirror): Promise<void> {
    const branch = this.#branch(s)
    await m.push(branch)
    this.#fault('pushed')
    // Read now, so that a switch to branch only applies to sessions that were already running.
    if ((await this.#o.coordinator.mode(repo.name)) === 'branch') {
      this.store.move(s.id, { type: 'branch.pushed' })
      return
    }
    const proof = this.store.verdict(s.id)?.proof ?? []
    const r = await this.#o.coordinator.propose({
      ticket: s.ticket,
      repo: repo.name,
      epoch: s.epoch!,
      head: branch,
      sha: s.head!,
      title: pullTitle(ticket),
      body: pullBody(ticket, proof, s.runtime),
    })
    this.#fault('proposed')
    if (r.kind === 'stale') this.store.move(s.id, { type: 'lease.lost' })
    else if (r.kind === 'branch-only') this.store.move(s.id, { type: 'branch.pushed' })
    else {
      await m.worktree(branch, this.reviewDir(s))
      this.#fault('worktree')
      this.store.move(s.id, { type: 'pull.opened', pull: r.pull })
    }
  }

  async #review(s: Session, m: Mirror): Promise<void> {
    if (!existsSync(this.reviewDir(s))) await m.worktree(this.#branch(s), this.reviewDir(s))
    const pull = await this.#o.coordinator.pull(s)
    if (pull?.state === 'merged') this.store.move(s.id, { type: 'pull.merged' })
    else if (pull?.state === 'closed') this.store.move(s.id, { type: 'pull.closed' })
    else await this.#nap(s.id, this.#o.pollMs)
  }

  /** Look at a pull request now and not at the next poll. */
  nudge(ticket: string): void {
    for (const s of this.store.open()) if (s.ticket === ticket) this.#wake.get(s.id)?.()
  }
}
