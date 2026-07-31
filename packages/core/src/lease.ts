export const LEASE_MS = 60_000

export interface Lease {
  epoch: number
  holder: string | null
  session: string | null
  until: number
}

export const NO_LEASE: Lease = { epoch: 0, holder: null, session: null, until: 0 }

export type Take = { ok: true; lease: Lease; fresh: boolean } | { ok: false; holder: string }

/**
 * Taking again with the same holder and session while the lease is live gives the same epoch back,
 * which is what makes a crash between taking it and writing it down harmless.
 */
export function take(l: Lease, holder: string, session: string, now: number, force = false): Take {
  const live = l.holder !== null && l.until > now
  if (live && l.holder === holder && l.session === session) {
    return { ok: true, fresh: false, lease: { ...l, until: now + LEASE_MS } }
  }
  if (live && !force) return { ok: false, holder: l.holder as string }
  return { ok: true, fresh: true, lease: { epoch: l.epoch + 1, holder, session, until: now + LEASE_MS } }
}

/** A lapsed lease can be renewed as long as nobody took the ticket in between: the epoch decides. */
export function renew(l: Lease, epoch: number, now: number): Lease | null {
  if (l.epoch !== epoch || l.holder === null) return null
  return { ...l, until: now + LEASE_MS }
}

export function release(l: Lease, epoch: number): Lease | null {
  if (l.epoch !== epoch || l.holder === null) return null
  return { ...l, holder: null, session: null, until: 0 }
}

export const branchName = (ticket: string, epoch: number): string => `fix/${ticket}/${epoch}`

export function parseBranch(branch: string): { ticket: string; epoch: number } | null {
  const m = /^fix\/([a-z0-9][a-z0-9-]{0,62})\/([1-9]\d{0,8})$/.exec(branch)
  return m ? { ticket: m[1] as string, epoch: Number(m[2]) } : null
}
