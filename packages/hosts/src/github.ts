import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Pull } from '@fixlane/core'
import { Octokit } from '@octokit/rest'
import { z } from 'zod'
import { PACE, type Pace, retry, waitFrom } from './retry.ts'
import { BadSignature, type GitHost, type Hook, HostError, type NewPull } from './types.ts'

export interface GitHubOptions {
  url: string
  token: string
  hookSecret: string
  pace?: Pace
}

interface Raw {
  number: number
  html_url: string
  state: string
  merged_at?: string | null
  head: { ref: string }
}

const HookBody = z.object({
  pull_request: z.object({ number: z.number().int() }),
  repository: z.object({ full_name: z.string() }),
})

const toPull = (r: Raw): Pull => ({
  number: r.number,
  url: r.html_url,
  head: r.head.ref,
  state: r.merged_at ? 'merged' : r.state === 'open' ? 'open' : 'closed',
})

const split = (project: string): { owner: string; repo: string } => {
  const [owner, repo] = project.split('/') as [string, string]
  return { owner, repo }
}

export class GitHub implements GitHost {
  readonly kind = 'github'
  readonly #api: Octokit
  readonly #pace: Pace
  readonly #secret: string

  constructor(o: GitHubOptions) {
    this.#pace = o.pace ?? PACE
    this.#secret = o.hookSecret
    const quiet = { debug() {}, info() {}, warn() {}, error() {} }
    this.#api = new Octokit({
      auth: o.token,
      baseUrl: o.url,
      log: quiet,
      // A fresh signal per request, so a host that never answers counts as no answer.
      request: {
        fetch: (u: string, init: RequestInit) => fetch(u, { ...init, signal: AbortSignal.timeout(15_000) }),
      },
    })
  }

  async #call<T>(fn: () => Promise<{ data: T }>): Promise<T> {
    try {
      return (await fn()).data
    } catch (e) {
      const { status, response, message } = e as {
        status?: number
        response?: { headers: object }
        message: string
      }
      // Octokit reports a lost connection as a 500 without a response.
      if (!status || !response) throw new HostError(null, message)
      throw new HostError(status, message, waitFrom(status, { ...response.headers }, this.#pace.now()))
    }
  }

  async #find(project: string, head: string): Promise<Pull | null> {
    const { owner, repo } = split(project)
    const list = await this.#call(() =>
      this.#api.pulls.list({
        owner,
        repo,
        head: `${owner}:${head}`,
        state: 'all',
        sort: 'created',
        direction: 'desc',
        per_page: 5,
      }),
    )
    const hit = (list as Raw[]).find((r) => r.head.ref === head)
    return hit ? toPull(hit) : null
  }

  findPull(project: string, head: string): Promise<Pull | null> {
    return retry(this.#pace, () => this.#find(project, head))
  }

  async getPull(project: string, number: number): Promise<Pull | null> {
    return retry(this.#pace, async () => {
      try {
        return toPull(
          (await this.#call(() => this.#api.pulls.get({ ...split(project), pull_number: number }))) as Raw,
        )
      } catch (e) {
        if (e instanceof HostError && e.status === 404) return null
        throw e
      }
    })
  }

  async openPull(project: string, p: NewPull): Promise<Pull> {
    const look = (): Promise<Pull | null> => this.#find(project, p.head)
    const there = await this.findPull(project, p.head)
    if (there) return there
    return retry(
      this.#pace,
      async () => {
        try {
          return toPull((await this.#call(() => this.#api.pulls.create({ ...split(project), ...p }))) as Raw)
        } catch (e) {
          // "A pull request already exists", while the list we just read did not have it yet.
          if (e instanceof HostError && e.status === 422 && /already exists/i.test(e.message)) {
            throw new HostError(null, 'created but not listed yet')
          }
          throw e
        }
      },
      look,
    )
  }

  async headSha(project: string, branch: string): Promise<string | null> {
    return retry(this.#pace, async () => {
      try {
        const b = await this.#call(() => this.#api.repos.getBranch({ ...split(project), branch }))
        return b.commit.sha
      } catch (e) {
        if (e instanceof HostError && e.status === 404) return null
        throw e
      }
    })
  }

  readHook(headers: Record<string, string | undefined>, body: string): Hook | null {
    const want = `sha256=${createHmac('sha256', this.#secret).update(body).digest('hex')}`
    const got = headers['x-hub-signature-256'] ?? ''
    if (got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want)))
      throw new BadSignature()
    if (headers['x-github-event'] !== 'pull_request') return null
    const b = HookBody.parse(JSON.parse(body))
    const delivery = headers['x-github-delivery'] ?? ''
    return { delivery, project: b.repository.full_name, number: b.pull_request.number }
  }
}
