import { setTimeout as delay } from 'node:timers/promises'
import { HostError } from './types.ts'

export interface Pace {
  tries: number
  sleep: (ms: number) => Promise<unknown>
  now: () => number
}

export const PACE: Pace = { tries: 6, sleep: (ms) => delay(ms), now: Date.now }
const LONGEST_WAIT = 120_000

type Headers = Record<string, unknown>
const num = (v: unknown): number | null => (v === undefined || v === null || v === '' ? null : Number(v))

/** GitHub and GitLab spell their limits differently. Both are seconds. */
export function waitFrom(status: number, headers: Headers, now: number): number | null {
  const after = num(headers['retry-after'])
  if (after !== null) return after * 1000
  const left = num(headers['x-ratelimit-remaining'] ?? headers['ratelimit-remaining'])
  const reset = num(headers['x-ratelimit-reset'] ?? headers['ratelimit-reset'])
  if (reset !== null && (left === 0 || status === 429)) return Math.max(0, reset * 1000 - now)
  return null
}

const worthRetrying = (e: HostError): boolean =>
  e.status === null || e.status >= 500 || e.status === 429 || e.retryAfterMs !== null

/** `before` runs ahead of every try but the first, and can settle the matter by returning a value. */
export async function retry<T>(
  pace: Pace,
  fn: () => Promise<T>,
  before?: () => Promise<T | null>,
): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      const settled = i > 0 && before ? await before() : null
      return settled ?? (await fn())
    } catch (e) {
      if (!(e instanceof HostError) || !worthRetrying(e) || i + 1 >= pace.tries) throw e
      const wait = e.retryAfterMs ?? 250 * 2 ** i
      if (wait > LONGEST_WAIT) throw e
      await pace.sleep(wait)
    }
  }
}
