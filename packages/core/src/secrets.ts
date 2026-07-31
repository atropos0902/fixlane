import { createHash } from 'node:crypto'
import type { KeyPrint } from './schema.ts'

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')

/** Finds the key a ticket names by hash, looking at every run of characters a key can be made of. */
export function findKey(text: string, print: KeyPrint): string | null {
  for (const m of text.matchAll(/[\w+/=.:@$%!~-]{8,}/g)) {
    const run = m[0]
    for (let i = 0; i + print.length <= run.length; i++) {
      const s = run.slice(i, i + print.length)
      if (sha(s) === print.sha256) return s
    }
  }
  return null
}

const squash = (s: string): string => s.replace(/['"`+\s\\,[\]()]/g, '')

/** The ways a key tends to come back after it was "removed". */
export function hides(text: string, key: string): string | null {
  if (text.includes(key)) return 'as it was'
  if (text.includes([...key].reverse().join(''))) return 'reversed'
  const b64 = Buffer.from(key).toString('base64').replace(/=+$/, '')
  if (text.includes(b64)) return 'as base64'
  if (text.includes(Buffer.from(key).toString('base64url').replace(/=+$/, ''))) return 'as base64'
  if (text.toLowerCase().includes(Buffer.from(key).toString('hex'))) return 'as hex'
  if (squash(text).includes(squash(key))) return 'in pieces'
  return null
}

const PATTERNS: readonly [string, RegExp][] = [
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ['live key', /\b(sk|rk)_live_[A-Za-z0-9]{16,}\b/g],
  ['assigned secret', /\b(?:secret|token|passw(?:or)?d|api_?key)\b["']?\s*[:=]\s*["'][^"'\s]{16,}["']/gi],
]

export interface Finding {
  path: string
  what: string
}

export function scan(files: ReadonlyMap<string, string>): Finding[] {
  const out: Finding[] = []
  for (const [path, text] of files) {
    for (const [what, re] of PATTERNS) for (const _ of text.matchAll(re)) out.push({ path, what })
  }
  return out
}

/** Null when the key is gone and nothing new was added, otherwise what is wrong. */
export function checkRemoval(
  base: ReadonlyMap<string, string>,
  head: ReadonlyMap<string, string>,
  print: KeyPrint,
): string | null {
  let key: string | null = null
  for (const text of base.values()) {
    key = findKey(text, print)
    if (key !== null) break
  }
  if (key === null) return 'the key in the ticket is not in the base tree'
  for (const [path, text] of head) {
    const how = hides(text, key)
    if (how) return `the key is still in ${path}, ${how}`
  }
  const count = (fs: Finding[]): Map<string, number> => {
    const m = new Map<string, number>()
    for (const f of fs) m.set(`${f.what} in ${f.path}`, (m.get(`${f.what} in ${f.path}`) ?? 0) + 1)
    return m
  }
  const before = count(scan(base))
  for (const [k, n] of count(scan(head))) if (n > (before.get(k) ?? 0)) return `there is a new ${k}`
  return null
}
