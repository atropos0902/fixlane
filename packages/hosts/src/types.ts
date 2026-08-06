import type { Pull } from '@fixlane/core'

export interface NewPull {
  head: string
  base: string
  title: string
  body: string
}

export interface Hook {
  delivery: string
  project: string
  number: number
}

export interface GitHost {
  readonly kind: 'github' | 'gitlab'
  /** The newest pull request from a branch, whatever state it is in. */
  findPull(project: string, head: string): Promise<Pull | null>
  getPull(project: string, number: number): Promise<Pull | null>
  /** Safe to call again: a pull request that already exists for the branch is returned, not duplicated. */
  openPull(project: string, p: NewPull): Promise<Pull>
  headSha(project: string, branch: string): Promise<string | null>
  /** Checks the signature and says which pull request to look at. Null when it is about something else. */
  readHook(headers: Record<string, string | undefined>, body: string): Hook | null
}

export class BadSignature extends Error {}

export class HostError extends Error {
  /** null when no answer came back at all */
  readonly status: number | null
  readonly retryAfterMs: number | null
  constructor(status: number | null, message: string, retryAfterMs: number | null = null) {
    super(`git host: ${status ?? 'no answer'}: ${message}`)
    this.status = status
    this.retryAfterMs = retryAfterMs
  }
}
