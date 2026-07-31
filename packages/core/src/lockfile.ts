import semver from 'semver'
import type { Advisory } from './schema.ts'

interface Entry {
  version?: string
  resolved?: string
  integrity?: string
  link?: boolean
}

export interface LockPackage {
  path: string
  name: string
  version: string
  resolved: string | null
  integrity: string | null
}

export function readLock(text: string): LockPackage[] {
  const lock = JSON.parse(text) as { lockfileVersion?: number; packages?: Record<string, Entry> }
  if ((lock.lockfileVersion ?? 0) < 2 || !lock.packages)
    throw new Error('the lockfile is older than version 2')
  return Object.entries(lock.packages)
    .filter(([path, e]) => path !== '' && !e.link && e.version)
    .map(([path, e]) => ({
      path,
      name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: e.version as string,
      resolved: e.resolved ?? null,
      integrity: e.integrity ?? null,
    }))
}

/** Asks the registry what the integrity of a version really is. */
export type Integrity = (name: string, version: string) => Promise<string | null>

/** Null when the bump holds up, otherwise what is wrong with it. */
export async function checkBump(
  baseText: string,
  headText: string,
  advisory: Advisory,
  registry: string,
  integrity: Integrity,
): Promise<string | null> {
  const hit = (p: LockPackage): boolean =>
    p.name === advisory.package && semver.satisfies(p.version, advisory.affected, { includePrerelease: true })
  const before = readLock(baseText)
  const after = readLock(headText)
  if (!before.some(hit)) return `${advisory.package} is not at an affected version on base`
  const left = after.filter(hit)
  if (left.length > 0) return `${left.map((p) => `${p.path}@${p.version}`).join(', ')} is still affected`

  const known = new Map(before.map((p) => [`${p.name}@${p.version}`, p]))
  for (const p of after) {
    if (p.resolved === null || p.integrity === null) return `${p.path} has no resolved URL or integrity`
    const old = known.get(`${p.name}@${p.version}`)
    if (old && old.resolved === p.resolved && old.integrity === p.integrity) continue
    if (!p.resolved.startsWith(registry)) return `${p.path} comes from ${p.resolved}`
    if (p.integrity !== (await integrity(p.name, p.version))) return `${p.path} does not match the registry`
  }
  return null
}
