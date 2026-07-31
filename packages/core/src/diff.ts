export const MAX_DIFF_LINES = 200

export interface FileChange {
  path: string
  /** git mode after the change, "000000" when the file is gone */
  mode: string
  status: 'A' | 'M' | 'D' | 'T'
  added: number
  removed: number
  binary: boolean
}

const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']
const CI = [
  /^\.github\//,
  /^\.gitlab\//,
  /^\.gitlab-ci\.ya?ml$/,
  /^\.circleci\//,
  /^\.buildkite\//,
  /^Jenkinsfile/,
  /^azure-pipelines/,
  /^\.husky\//,
]
// These change where packages come from, or how git and npm behave on the reviewer's machine.
const TOOLING = [/(^|\/)\.npmrc$/, /(^|\/)\.gitmodules$/, /(^|\/)\.gitattributes$/, /(^|\/)\.yarnrc(\.yml)?$/]

const name = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
export const isLockfile = (p: string): boolean => LOCKFILES.includes(name(p))
export const isTest = (p: string): boolean =>
  /(^|\/)(test|tests|__tests__)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)

/** Null when the change is small and plain enough to go on. Otherwise, why a person should look. */
export function needsPerson(changes: readonly FileChange[]): string | null {
  if (changes.length === 0) return 'the branch changes nothing'
  for (const c of changes) {
    if (c.mode === '120000') return `${c.path} is a symlink`
    if (c.mode === '160000') return `${c.path} is a submodule`
    if (CI.some((r) => r.test(c.path))) return `${c.path} is CI configuration`
    if (TOOLING.some((r) => r.test(c.path))) return `${c.path} changes how tools behave`
    if (c.binary) return `${c.path} is binary`
  }
  const lines = changes.filter((c) => !isLockfile(c.path)).reduce((n, c) => n + c.added + c.removed, 0)
  return lines > MAX_DIFF_LINES ? `the diff is ${lines} lines, over ${MAX_DIFF_LINES}` : null
}

/** Reads `git diff --raw -z --no-renames` and `git diff --numstat -z --no-renames`. */
export function parseChanges(raw: string, numstat: string): FileChange[] {
  const counts = new Map<string, { added: number; removed: number; binary: boolean }>()
  for (const row of numstat.split('\0')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(row)
    if (!m) continue
    const binary = m[1] === '-'
    counts.set(m[3]!, { added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary })
  }
  const out: FileChange[] = []
  const parts = raw.split('\0')
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const m = /^:\d{6} (\d{6}) \S+ \S+ ([AMDT])/.exec(parts[i]!.trimStart())
    const path = parts[i + 1]!
    if (!m) throw new Error(`cannot read diff entry ${JSON.stringify(parts[i])}`)
    const c = counts.get(path) ?? { added: 0, removed: 0, binary: false }
    out.push({ path, mode: m[1]!, status: m[2] as FileChange['status'], ...c })
  }
  return out
}
