// What a clone per agent costs against a worktree per agent.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { random } from './daemon.ts'

const root = mkdtempSync(join(tmpdir(), 'fl-layout-'))
const seed = join(root, 'seed')
const git = (cwd: string, ...a: string[]): string =>
  execFileSync(
    'git',
    ['-c', 'user.name=a', '-c', 'user.email=a@b', '-c', 'init.defaultBranch=main', '-c', 'gc.auto=0', ...a],
    { cwd, encoding: 'utf8' },
  ).trim()
const rnd = random(1)
const FILES = 4000
const COMMITS = 300
mkdirSync(seed)
git(seed, 'init', '-q')
const body = (): string =>
  Array.from({ length: 60 }, () => `const x${Math.floor(rnd() * 1e9)} = ${rnd()}`).join('\n')
for (let i = 0; i < FILES; i++) {
  const d = join(seed, `d${i % 80}`)
  mkdirSync(d, { recursive: true })
  writeFileSync(join(d, `f${i}.js`), body())
}
git(seed, 'add', '-A')
git(seed, 'commit', '-qm', 'all')
for (let c = 0; c < COMMITS; c++) {
  for (let n = 0; n < 8; n++) {
    const i = Math.floor(rnd() * FILES)
    writeFileSync(join(seed, `d${i % 80}`, `f${i}.js`), body())
  }
  git(seed, 'commit', '-qam', `c${c}`)
}
git(root, 'clone', '-q', '--bare', seed, 'mirror.git')
const mirror = join(root, 'mirror.git')
git(mirror, 'gc', '-q')
const kb = (p: string): number => Number(execFileSync('du', ['-sk', p], { encoding: 'utf8' }).split('\t')[0])

const layouts: Record<string, (d: string, i: number) => void> = {
  'shared clone': (d, i) => {
    git(root, 'clone', '-q', '--shared', '--no-tags', '--template=', mirror, d)
    git(d, 'checkout', '-q', '-b', `s${i}`)
  },
  worktree: (d, i) => void git(mirror, 'worktree', 'add', '-q', '-b', `w${i}`, d, 'main'),
  'full clone': (d, i) => {
    git(root, 'clone', '-q', '--no-local', '--no-tags', '--template=', mirror, d)
    git(d, 'checkout', '-q', '-b', `f${i}`)
  },
}
const N = 15
const result: Record<string, object> = {
  repository: { files: FILES, commits: COMMITS + 1, mirrorKb: kb(mirror) },
}
for (const [name, make] of Object.entries(layouts)) {
  const ms: number[] = []
  const before = kb(mirror)
  let size = 0
  let gitSize = 0
  for (let i = 0; i < N; i++) {
    const d = join(root, `${name.replace(' ', '-')}-${i}`)
    const t = performance.now()
    make(d, i)
    ms.push(performance.now() - t)
    if (i === 0) {
      size = kb(d)
      gitSize = kb(join(d, '.git'))
    }
    if (name !== 'worktree') rmSync(d, { recursive: true })
  }
  if (name === 'worktree') gitSize += Math.round((kb(mirror) - before) / N)
  ms.sort((a, b) => a - b)
  result[name] = {
    medianMs: Math.round(ms[Math.floor(N / 2)]!),
    filesKb: size - (name === 'worktree' ? 0 : gitSize),
    gitKb: gitSize,
  }
}
writeFileSync(new URL('results/layout.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
console.log(result)
rmSync(root, { recursive: true })
