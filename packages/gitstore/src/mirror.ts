import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type FileChange, parseChanges } from '@fixlane/core'
import { GitError, type GitOptions, git, gitRaw } from './git.ts'

export interface Remote {
  url: string
  user: string
  token: string
}

export interface CloneOptions {
  session: string
  dest: string
  base: string
  branch: string
  /** where the borrowed objects will be found, when that is not where they are now */
  objectsAs?: string | null
}

export const MAX_BUNDLE = 20 * 1024 * 1024

/** The header of a git bundle is text up to an empty line. The rest is a pack. */
export function readBundle(bytes: Buffer): { tip: string; pack: Buffer } {
  if (bytes.length > MAX_BUNDLE) throw new Error('the bundle is too big')
  const end = bytes.indexOf('\n\n')
  const lines = end < 0 ? [] : bytes.subarray(0, end).toString('utf8').split('\n')
  if (lines[0] !== '# v2 git bundle') throw new Error('not a git bundle')
  const tip = lines.map((l) => /^([0-9a-f]{40}) HEAD$/.exec(l)?.[1]).find(Boolean)
  if (!tip) throw new Error('the bundle has no HEAD')
  return { tip, pack: bytes.subarray(end + 2) }
}

/**
 * One bare repository per project. Agents borrow its objects through a shared clone, and only the
 * daemon ever runs git in here.
 */
export class Mirror {
  readonly dir: string
  readonly #remote: Remote
  #tail: Promise<unknown> = Promise.resolve()

  constructor(dir: string, remote: Remote) {
    this.dir = dir
    this.#remote = remote
  }

  get objects(): string {
    return join(this.dir, 'objects')
  }

  /** Clone, fetch and gc take turns. */
  #alone<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(fn, fn)
    this.#tail = next.catch(() => {})
    return next
  }

  #git(args: readonly string[], o: GitOptions = {}): Promise<string> {
    return git(args, { cwd: this.dir, ...o })
  }

  #auth(): Record<string, string> {
    const basic = Buffer.from(`${this.#remote.user}:${this.#remote.token}`).toString('base64')
    return { 'http.extraHeader': `Authorization: Basic ${basic}` }
  }

  async open(): Promise<void> {
    await this.#alone(async () => {
      if (!existsSync(join(this.dir, 'HEAD'))) {
        await mkdir(this.dir, { recursive: true })
        await git(['init', '-q', '--bare', '--template=', this.dir])
      }
      await mkdir(join(this.dir, 'holds'), { recursive: true })
    })
  }

  async fetchBase(base: string): Promise<string> {
    return this.#alone(async () => {
      const spec = `+refs/heads/${base}:refs/heads/${base}`
      await this.#git(['fetch', '-q', '--no-tags', this.#remote.url, spec], { config: this.#auth() })
      return this.#git(['rev-parse', `refs/heads/${base}`])
    })
  }

  /** A clone for one agent. It has its own refs, stash, hooks and config, and no remote. */
  async clone(o: CloneOptions): Promise<void> {
    await this.#alone(async () => {
      // The hold goes down before the clone exists, so gc can never slip in between.
      await writeFile(join(this.dir, 'holds', o.session), o.dest)
      await rm(o.dest, { recursive: true, force: true })
      await git(['clone', '-q', '--shared', '--no-checkout', '--no-tags', '--template=', this.dir, o.dest])
      await git(['remote', 'remove', 'origin'], { cwd: o.dest })
      await git(['checkout', '-q', '-B', o.branch, o.base], { cwd: o.dest })
      if (o.objectsAs) await writeFile(join(o.dest, '.git/objects/info/alternates'), `${o.objectsAs}\n`)
    })
  }

  async release(session: string): Promise<void> {
    await rm(join(this.dir, 'holds', session), { force: true })
  }

  holds(): Promise<string[]> {
    return readdir(join(this.dir, 'holds'))
  }

  /** A prune breaks every clone that borrows from here, so it waits until there are none. */
  async gc(): Promise<{ ran: boolean; heldBy: string[] }> {
    return this.#alone(async () => {
      const heldBy = await this.holds()
      if (heldBy.length > 0) return { ran: false, heldBy }
      await this.#git(['gc', '-q', '--prune=now'])
      return { ran: true, heldBy }
    })
  }

  /**
   * Takes what came out of the sandbox as a bundle. Only the tree is kept: the commit is made here, so
   * author, date and message are ours whatever the agent put in its own commits. The same input always
   * gives the same commit, and a crash half way through is repaired by doing it again.
   */
  async importBundle(bytes: Buffer, base: string, branch: string, message: string): Promise<string> {
    return this.#alone(async () => {
      const { tip, pack } = readBundle(bytes)
      // `git fetch` does not apply fetch.fsckObjects to a bundle on older gits, so the pack goes in by hand.
      const strict = ['index-pack', '--stdin', '--fix-thin', '--strict', `--max-input-size=${MAX_BUNDLE}`]
      await this.#git(strict, { input: pack, timeoutMs: 60_000 })
      const incoming = `refs/incoming/${branch}`
      await this.#git(['update-ref', incoming, tip])
      try {
        await this.#git(['merge-base', '--is-ancestor', base, incoming])
      } catch (e) {
        if (e instanceof GitError && e.exit === 1)
          throw new Error('the bundle does not build on the base commit')
        throw e
      }
      const date = await this.#git(['show', '-s', '--format=%cI', base])
      const who = { NAME: 'fixlane', EMAIL: 'fixlane@localhost', DATE: date }
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(who)) {
        env[`GIT_AUTHOR_${k}`] = v
        env[`GIT_COMMITTER_${k}`] = v
      }
      const sha = await this.#git(['commit-tree', `${incoming}^{tree}`, '-p', base, '-m', message], { env })
      await this.#git(['update-ref', `refs/heads/${branch}`, sha])
      await this.#git(['update-ref', '-d', incoming])
      return sha
    })
  }

  async changes(base: string, head: string): Promise<FileChange[]> {
    const flags = ['--no-renames', '--no-ext-diff', '--no-textconv', '-z']
    const raw = await this.#git(['diff', '--raw', ...flags, base, head])
    const num = await this.#git(['diff', '--numstat', ...flags, base, head])
    return parseChanges(raw, num)
  }

  diff(base: string, head: string): Promise<string> {
    return this.#git(['diff', '--no-renames', '--no-ext-diff', '--no-textconv', base, head])
  }

  async show(sha: string, path: string): Promise<string | null> {
    try {
      return (await gitRaw(['cat-file', 'blob', `${sha}:${path}`], { cwd: this.dir })).toString('utf8')
    } catch (e) {
      if (e instanceof GitError) return null
      throw e
    }
  }

  async files(sha: string): Promise<string[]> {
    const out = await this.#git(['ls-tree', '-r', '-z', '--name-only', sha])
    return out.split('\0').filter(Boolean)
  }

  async texts(sha: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    for (const path of await this.files(sha)) {
      const text = await this.show(sha, path)
      if (text !== null && !text.includes('\0')) out.set(path, text)
    }
    return out
  }

  /** The files of a commit in a plain directory, with no .git in it. */
  async unpack(sha: string, dest: string, paths: readonly string[] = []): Promise<void> {
    await mkdir(dest, { recursive: true })
    const tar = await gitRaw(['archive', '--format=tar', sha, '--', ...paths], { cwd: this.dir })
    await new Promise<void>((resolve, reject) => {
      const p = spawn('tar', ['-x', '--no-same-owner', '-C', dest], { stdio: ['pipe', 'ignore', 'inherit'] })
      p.on('error', reject)
      p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`tar exited with ${c}`))))
      p.stdin.end(tar)
    })
  }

  /** The reviewer's worktree. Calling it twice is fine. */
  async worktree(branch: string, dest: string): Promise<void> {
    await this.#alone(async () => {
      if (existsSync(join(dest, '.git'))) {
        const at = (await readFile(join(dest, '.git'), 'utf8')).trim()
        if (at.startsWith(`gitdir: ${this.dir}`)) {
          await git(['reset', '-q', '--hard', `refs/heads/${branch}`], { cwd: dest })
          return
        }
      }
      await rm(dest, { recursive: true, force: true })
      await this.#git(['worktree', 'prune'])
      await this.#git(['worktree', 'add', '-q', '--force', dest, branch])
    })
  }

  async removeWorktree(dest: string): Promise<void> {
    await this.#alone(async () => {
      await rm(dest, { recursive: true, force: true })
      await this.#git(['worktree', 'prune'])
    })
  }

  async push(branch: string): Promise<void> {
    const ref = `refs/heads/${branch}`
    await this.#git(['push', '-q', '--no-verify', this.#remote.url, `+${ref}:${ref}`], {
      config: this.#auth(),
    })
  }
}
