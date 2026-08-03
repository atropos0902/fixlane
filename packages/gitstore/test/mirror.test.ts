import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { Mirror } from '../src/index.ts'

let root: string
let upstream: string
let mirror: Mirror
let base: string

/** What an agent does in its own clone: plain git, with whatever config it likes. */
const sh = (cwd: string, script: string): string =>
  execFileSync('bash', ['-ec', script], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_AUTHOR_NAME: 'The Boss',
      GIT_AUTHOR_EMAIL: 'boss@example.com',
      GIT_COMMITTER_NAME: 'The Boss',
      GIT_COMMITTER_EMAIL: 'boss@example.com',
    },
  }).trim()

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'fixlane-git-'))
  upstream = join(root, 'upstream.git')
  mkdirSync(join(root, 'seed'))
  sh(root, 'git init -q --bare -b main upstream.git')
  sh(
    join(root, 'seed'),
    `git init -q -b main . && echo one > f && git add f && git commit -qm one && git push -q ${upstream} main`,
  )
  mirror = new Mirror(join(root, 'mirror.git'), { url: upstream, user: 'x', token: 'y' })
  await mirror.open()
  base = await mirror.fetchBase('main')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const cloneFor = async (session: string): Promise<string> => {
  const dest = join(root, session)
  await mirror.clone({ session, dest, base, branch: `fix/t/1` })
  return dest
}
const bundle = (dir: string): Buffer => {
  const f = join(root, 'b.bundle')
  sh(dir, `git bundle create -q ${f} ${base}..HEAD`)
  return readFileSync(f)
}

describe('what a worktree shares, which is why agents do not get one', () => {
  test('a stash made in one worktree can be popped in another', () => {
    const seed = join(root, 'seed')
    sh(seed, `git worktree add -q ../a -b a && git worktree add -q ../b -b b`)
    sh(join(root, 'a'), 'echo from-a >> f && git stash -q')
    sh(join(root, 'b'), 'git stash pop -q')
    expect(readFileSync(join(root, 'b', 'f'), 'utf8')).toContain('from-a')
  })

  test('a hook written from a worktree runs in the main checkout', () => {
    const seed = join(root, 'seed')
    sh(seed, 'git worktree add -q ../a -b a')
    sh(
      join(root, 'a'),
      `h=$(git rev-parse --git-path hooks); mkdir -p $h; printf '#!/bin/sh\\ntouch ${root}/ran\\n' > $h/pre-commit; chmod +x $h/pre-commit`,
    )
    sh(seed, 'echo two >> f && git commit -qam two')
    expect(existsSync(join(root, 'ran'))).toBe(true)
  })
})

describe('clones', () => {
  test('stash, hooks and config stay in the clone', async () => {
    const a = await cloneFor('a')
    const b = await cloneFor('b')
    sh(
      a,
      `mkdir -p .git/hooks; for h in pre-commit post-checkout post-merge reference-transaction; do printf '#!/bin/sh\\ntouch ${root}/ran-$(basename $PWD)\\n' > .git/hooks/$h; chmod +x .git/hooks/$h; done; git config alias.st '!touch ${root}/alias'; echo from-a >> f; git stash -q`,
    )
    rmSync(join(root, 'ran-a'), { force: true })
    expect(sh(b, 'git stash list')).toBe('')
    expect(readdirSync(join(b, '.git')).includes('hooks')).toBe(false)
    expect(readFileSync(join(mirror.dir, 'config'), 'utf8')).not.toContain('alias')

    sh(a, 'git stash pop -q; git commit -qam mine')
    rmSync(join(root, 'ran-a'), { force: true })
    await mirror.importBundle(bundle(a), base, 'fix/t/1', 'fix')
    await mirror.worktree('fix/t/1', join(root, 'review'))
    expect(readdirSync(root).filter((n) => n.startsWith('ran-') || n === 'alias')).toEqual([])
    expect(readFileSync(join(root, 'review', 'f'), 'utf8')).toContain('from-a')
  })

  test('a clone has no remote to push to', async () => {
    const a = await cloneFor('a')
    expect(sh(a, 'git remote')).toBe('')
    expect(readFileSync(join(a, '.git', 'config'), 'utf8')).not.toContain(upstream)
  })

  test('pruning under an open clone breaks it', async () => {
    const a = await cloneFor('a')
    const tip = sh(a, 'echo x >> f; git commit -qam x; git rev-parse HEAD')
    await mirror.importBundle(bundle(a), base, 'fix/t/1', 'fix')
    const c = join(root, 'c')
    sh(root, `git clone -q --shared -b fix/t/1 ${mirror.dir} c`)
    sh(mirror.dir, 'git update-ref -d refs/heads/fix/t/1; git gc -q --prune=now')
    expect(() => sh(c, 'git log --oneline')).toThrow()
    expect(tip).toMatch(/^[0-9a-f]{40}$/)
  })

  test('gc waits for the last clone', async () => {
    await cloneFor('a')
    await cloneFor('b')
    expect(await mirror.gc()).toEqual({ ran: false, heldBy: ['a', 'b'] })
    await mirror.release('a')
    expect((await mirror.gc()).ran).toBe(false)
    await mirror.release('b')
    expect((await mirror.gc()).ran).toBe(true)
  })

  test('gc called while a clone is being made does not get in first', async () => {
    const [, gc] = await Promise.all([cloneFor('a'), mirror.gc()])
    expect(gc.ran).toBe(false)
  })
})

describe('bundles', () => {
  test('author, date and message are ours, and doing it twice gives the same commit', async () => {
    const a = await cloneFor('a')
    sh(a, 'echo x >> f; git commit -qam "closes #1, cc @everyone"')
    const one = await mirror.importBundle(bundle(a), base, 'fix/t/1', 'Fix t')
    const two = await mirror.importBundle(bundle(a), base, 'fix/t/1', 'Fix t')
    expect(two).toBe(one)
    const seen = sh(mirror.dir, `git log -1 --format='%an|%ae|%cn|%B' ${one}`)
    expect(seen).toBe('fixlane|fixlane@localhost|fixlane|Fix t')
    expect(sh(mirror.dir, 'git for-each-ref refs/incoming')).toBe('')
  })

  test('a bundle that does not build on base is refused', async () => {
    const a = await cloneFor('a')
    sh(
      a,
      'git checkout -q --orphan other; echo x > f; git commit -qam x; git bundle create -q ../b.bundle HEAD',
    )
    await expect(
      mirror.importBundle(readFileSync(join(root, 'b.bundle')), base, 'fix/t/1', 'm'),
    ).rejects.toThrow('does not build')
  })

  test('broken objects are refused', async () => {
    const a = await cloneFor('a')
    sh(
      a,
      `blob=$(echo x | git hash-object -w --stdin)
       tree=$(printf "100644 blob $blob\\t.git\\n" | git -c core.protectHFS=false mktree --missing)
       c=$(git commit-tree $tree -p HEAD -m bad); git reset -q --soft $c; git bundle create -q ../b.bundle ${base}..HEAD`,
    )
    await expect(
      mirror.importBundle(readFileSync(join(root, 'b.bundle')), base, 'fix/t/1', 'm'),
    ).rejects.toThrow(/hasDotgit/)
  })

  test('garbage is refused', async () => {
    writeFileSync(join(root, 'b.bundle'), 'not a bundle')
    await expect(
      mirror.importBundle(readFileSync(join(root, 'b.bundle')), base, 'fix/t/1', 'm'),
    ).rejects.toThrow('not a git bundle')
  })
})

test('changes see modes, deletions, odd names and binaries', async () => {
  const a = await cloneFor('a')
  sh(
    a,
    `printf 'a\\nb\\n' > 'odd name\t.txt'; ln -s /etc/passwd link; printf '\\0\\1' > bin; git rm -q f; git add -A; git commit -qm x`,
  )
  const head = await mirror.importBundle(bundle(a), base, 'fix/t/1', 'm')
  const by = new Map((await mirror.changes(base, head)).map((c) => [c.path, c]))
  expect(by.get('odd name\t.txt')).toMatchObject({ status: 'A', added: 2 })
  expect(by.get('link')).toMatchObject({ mode: '120000' })
  expect(by.get('bin')).toMatchObject({ binary: true })
  expect(by.get('f')).toMatchObject({ status: 'D', removed: 1 })
})

test('unpack writes plain files', async () => {
  await mirror.unpack(base, join(root, 'out'))
  expect(readdirSync(join(root, 'out'))).toEqual(['f'])
})

test('push sends the branch and nothing else', async () => {
  const a = await cloneFor('a')
  sh(a, 'echo x >> f; git commit -qam x')
  const head = await mirror.importBundle(bundle(a), base, 'fix/t/1', 'm')
  await mirror.push('fix/t/1')
  expect(sh(upstream, 'git for-each-ref --format="%(refname) %(objectname)"').split('\n')).toEqual([
    `refs/heads/fix/t/1 ${head}`,
    `refs/heads/main ${base}`,
  ])
})
