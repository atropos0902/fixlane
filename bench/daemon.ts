import { type ChildProcess, spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import type { SessionView, StateView } from '@fixlane/daemon/api'

const MAIN = new URL('../packages/daemon/src/main.ts', import.meta.url).pathname

/** The real daemon in its own process, so that it can really be killed. */
export class Daemon {
  readonly dir: string
  readonly #config: string
  #p: ChildProcess | null = null
  gone: Promise<void> = Promise.resolve()
  log = ''

  constructor(dir: string, config: object) {
    this.dir = dir
    mkdirSync(dir, { recursive: true })
    this.#config = join(dir, 'config.json')
    writeFileSync(this.#config, JSON.stringify({ dir, ...config }))
  }

  /** Resolves when it answers, or false when it died first. */
  async start(env: Record<string, string> = {}): Promise<boolean> {
    const p = spawn(process.execPath, [MAIN, this.#config], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.#p = p
    this.gone = new Promise((r) => p.once('exit', () => r()))
    let dead = false
    void this.gone.then(() => {
      dead = true
    })
    const ready = new Promise<boolean>((r) => {
      p.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('listening')) r(true)
      })
      void this.gone.then(() => r(false))
    })
    p.stderr!.on('data', (d: Buffer) => {
      this.log += d
    })
    return (await ready) && !dead
  }

  kill(signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
    this.#p?.kill(signal)
    return this.gone
  }
  get alive(): boolean {
    return this.#p !== null && this.#p.exitCode === null && this.#p.signalCode === null
  }

  call<T>(method: string, path: string, body?: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      const q = request(
        { socketPath: join(this.dir, 'sock'), method, path, headers: { 'content-type': 'application/json' } },
        (r) => {
          let t = ''
          r.on('data', (d) => {
            t += d
          })
          r.on('end', () => {
            const v = JSON.parse(t || '{}') as T & { error?: string }
            if ((r.statusCode ?? 500) >= 400) reject(new Error(v.error))
            else resolve(v)
          })
          r.on('error', reject)
        },
      )
      q.on('error', reject)
      q.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  state(): Promise<StateView> {
    return this.call('GET', '/v1/state')
  }
  session(id: string): Promise<SessionView> {
    return this.call('GET', `/v1/sessions/${id}`)
  }
}

export const until = async (fn: () => Promise<boolean> | boolean, ms: number): Promise<boolean> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 60))
  }
  return false
}

export const random = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
