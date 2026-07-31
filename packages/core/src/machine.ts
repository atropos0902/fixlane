import type { Pull, SessionState } from './schema.ts'

export const MAX_ATTEMPTS = 2

/** The part of a session the machine decides on. */
export interface Progress {
  state: SessionState
  attempt: number
  epoch: number | null
  reason: string | null
  feedback: string | null
  pull: Pull | null
  outcome: 'merged' | 'branch' | null
}

export type Happening =
  | { type: 'leased'; epoch: number }
  | { type: 'cloned' }
  | { type: 'agent.finished' }
  | { type: 'agent.stopped'; reason: string }
  | { type: 'agent.failed'; error: string }
  | { type: 'checks.passed' }
  | { type: 'checks.failed'; why: string; retry: boolean }
  | { type: 'branch.pushed' }
  | { type: 'pull.opened'; pull: Pull }
  | { type: 'pull.merged' }
  | { type: 'pull.closed' }
  | { type: 'lease.lost' }
  | { type: 'cancelled'; by: string }

export const START: Progress = {
  state: 'queued',
  attempt: 1,
  epoch: null,
  reason: null,
  feedback: null,
  pull: null,
  outcome: null,
}

export class BadMove extends Error {
  constructor(state: SessionState, happening: string) {
    super(`${happening} is not possible in ${state}`)
  }
}

export const isOver = (s: SessionState): boolean => s === 'done' || s === 'stopped'

const ALLOWED: Record<Happening['type'], readonly SessionState[]> = {
  leased: ['queued'],
  cloned: ['cloning'],
  'agent.finished': ['running'],
  'agent.stopped': ['running'],
  'agent.failed': ['running'],
  'checks.passed': ['checking'],
  'checks.failed': ['checking'],
  'branch.pushed': ['proposing'],
  'pull.opened': ['proposing'],
  'pull.merged': ['in_review'],
  'pull.closed': ['in_review'],
  // Once a PR is open the ticket no longer needs a lease, so losing it means nothing there.
  'lease.lost': ['cloning', 'running', 'checking', 'proposing'],
  cancelled: ['queued', 'cloning', 'running', 'checking', 'proposing', 'in_review'],
}

export function advance(p: Progress, h: Happening): Progress {
  if (!ALLOWED[h.type].includes(p.state)) throw new BadMove(p.state, h.type)
  const stop = (reason: string): Progress => ({ ...p, state: 'stopped', reason })
  const again = (why: string): Progress =>
    p.attempt < MAX_ATTEMPTS
      ? { ...p, state: 'cloning', attempt: p.attempt + 1, feedback: why }
      : stop(`gave up after ${MAX_ATTEMPTS} attempts: ${why}`)

  switch (h.type) {
    case 'leased':
      return { ...p, state: 'cloning', epoch: h.epoch }
    case 'cloned':
      return { ...p, state: 'running' }
    case 'agent.finished':
      return { ...p, state: 'checking' }
    case 'agent.stopped':
      return stop(h.reason)
    case 'agent.failed':
      return again(h.error)
    case 'checks.passed':
      return { ...p, state: 'proposing' }
    case 'checks.failed':
      return h.retry ? again(h.why) : stop(h.why)
    case 'branch.pushed':
      return { ...p, state: 'done', outcome: 'branch' }
    case 'pull.opened':
      return { ...p, state: 'in_review', pull: h.pull }
    case 'pull.merged':
      return { ...p, state: 'done', outcome: 'merged' }
    case 'pull.closed':
      return stop('the pull request was closed without merging')
    case 'lease.lost':
      return stop('another desktop took this ticket')
    case 'cancelled':
      return stop(`cancelled by ${h.by}`)
  }
}
