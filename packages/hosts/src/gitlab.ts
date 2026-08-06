import { createHash, timingSafeEqual } from 'node:crypto'
import type { Pull } from '@fixlane/core'
import { createRequesterFn } from '@gitbeaker/requester-utils'
import { Gitlab } from '@gitbeaker/rest'
import { z } from 'zod'
import { PACE, type Pace, retry, waitFrom } from './retry.ts'
import { BadSignature, type GitHost, type Hook, HostError, type NewPull } from './types.ts'

export interface GitLabOptions {
  url: string
  token: string
  hookSecret: string
  pace?: Pace
}

interface Raw {
  iid: number
  web_url: string
  state: string
  source_branch: string
}

const HookBody = z.object({
  object_attributes: z.object({ iid: z.number().int() }),
  project: z.object({ path_with_namespace: z.string() }),
})

const toPull = (r: Raw): Pull => ({
  number: r.iid,
  url: r.web_url,
  head: r.source_branch,
  state: r.state === 'merged' ? 'merged' : r.state === 'opened' || r.state === 'locked' ? 'open' : 'closed',
})

/**
 * Gitbeaker's own requester sends a POST again, up to ten times and without a real pause, when it gets
 * a 502. The first one may well have gone through. This one tries once and leaves the rest to `retry`.
 */
function once(now: () => number): ReturnType<typeof createRequesterFn> {
  return createRequesterFn(
    (_, o) => Promise.resolve(o),
    async (endpoint, o) => {
      const { prefixUrl, searchParams, method, headers, body } = (o ?? {}) as {
        prefixUrl: string
        searchParams?: string
        method: string
        headers?: Record<string, string>
        body?: string
      }
      const url = new URL(endpoint, prefixUrl.endsWith('/') ? prefixUrl : `${prefixUrl}/`)
      url.search = searchParams ?? ''
      let r: Response
      let text: string
      try {
        const init: RequestInit = { method, signal: AbortSignal.timeout(15_000) }
        if (headers) init.headers = headers
        if (body !== undefined) init.body = body
        r = await fetch(url, init)
        text = await r.text()
      } catch (e) {
        throw new HostError(null, (e as Error).message)
      }
      const h = Object.fromEntries(r.headers)
      if (!r.ok) throw new HostError(r.status, text.slice(0, 300), waitFrom(r.status, h, now()))
      return { body: text === '' ? null : JSON.parse(text), headers: h, status: r.status }
    },
  )
}

const hash = (s: string): Buffer => createHash('sha256').update(s).digest()

export class GitLab implements GitHost {
  readonly kind = 'gitlab'
  readonly #api: InstanceType<typeof Gitlab>
  readonly #pace: Pace
  readonly #secret: string

  constructor(o: GitLabOptions) {
    this.#pace = o.pace ?? PACE
    this.#secret = o.hookSecret
    this.#api = new Gitlab({ host: o.url, token: o.token, requesterFn: once(this.#pace.now) })
  }

  async #find(project: string, head: string): Promise<Pull | null> {
    const list = (await this.#api.MergeRequests.all({
      projectId: project,
      sourceBranch: head,
      orderBy: 'created_at',
      sort: 'desc',
      perPage: 5,
      maxPages: 1,
    })) as unknown as Raw[]
    const hit = list.find((r) => r.source_branch === head)
    return hit ? toPull(hit) : null
  }

  findPull(project: string, head: string): Promise<Pull | null> {
    return retry(this.#pace, () => this.#find(project, head))
  }

  async getPull(project: string, number: number): Promise<Pull | null> {
    return retry(this.#pace, async () => {
      try {
        return toPull((await this.#api.MergeRequests.show(project, number)) as unknown as Raw)
      } catch (e) {
        if (e instanceof HostError && e.status === 404) return null
        throw e
      }
    })
  }

  async openPull(project: string, p: NewPull): Promise<Pull> {
    const there = await this.findPull(project, p.head)
    if (there) return there
    return retry(
      this.#pace,
      async () => {
        try {
          const made = await this.#api.MergeRequests.create(project, p.head, p.base, p.title, {
            description: p.body,
          })
          return toPull(made as unknown as Raw)
        } catch (e) {
          if (e instanceof HostError && e.status === 409)
            throw new HostError(null, 'created but not listed yet')
          throw e
        }
      },
      () => this.#find(project, p.head),
    )
  }

  async headSha(project: string, branch: string): Promise<string | null> {
    return retry(this.#pace, async () => {
      try {
        return (await this.#api.Branches.show(project, branch)).commit.id as string
      } catch (e) {
        if (e instanceof HostError && e.status === 404) return null
        throw e
      }
    })
  }

  readHook(headers: Record<string, string | undefined>, body: string): Hook | null {
    if (!timingSafeEqual(hash(headers['x-gitlab-token'] ?? ''), hash(this.#secret))) throw new BadSignature()
    if (headers['x-gitlab-event'] !== 'Merge Request Hook') return null
    const b = HookBody.parse(JSON.parse(body))
    const delivery = headers['x-gitlab-event-uuid'] ?? headers['idempotency-key'] ?? ''
    return { delivery, project: b.project.path_with_namespace, number: b.object_attributes.iid }
  }
}
