import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { GitHub, GitLab } from '../src/index.ts'

// Against real test accounts, at night: FIXLANE_LIVE_GITHUB and FIXLANE_LIVE_GITLAB hold
// {"url": API, "git": clone URL, "user", "token", "project"} for a repository that can be thrown away.
const accounts = [
  ['github', process.env.FIXLANE_LIVE_GITHUB, GitHub],
  ['gitlab', process.env.FIXLANE_LIVE_GITLAB, GitLab],
] as const

describe.each(accounts)('%s', (_, raw, Host) => {
  const dir = mkdtempSync(join(tmpdir(), 'fixlane-live-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test.skipIf(!raw)(
    'opens one pull request for a branch, twice',
    async () => {
      const c = JSON.parse(raw!) as Record<'url' | 'git' | 'user' | 'token' | 'project', string>
      const head = `fix/live-test/${Math.floor(Date.now() / 1000)}`
      const basic = Buffer.from(`${c.user}:${c.token}`).toString('base64')
      const env = {
        ...process.env,
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'http.extraHeader',
        GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
      }
      const git = (...a: string[]) => execFileSync('git', a, { cwd: dir, env, encoding: 'utf8' }).trim()
      git('clone', '-q', '--depth', '1', c.git, '.')
      git('checkout', '-q', '-b', head)
      git(
        '-c',
        'user.name=fixlane',
        '-c',
        'user.email=fixlane@localhost',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'live test',
      )
      git('push', '-q', 'origin', head)
      const h = new Host({ url: c.url, token: c.token, hookSecret: 'x' })
      expect(await h.headSha(c.project, head)).toBe(git('rev-parse', 'HEAD'))
      const draft = {
        head,
        base: git('rev-parse', '--abbrev-ref', 'origin/HEAD').replace('origin/', ''),
        title: 'live test',
        body: '',
      }
      const [a, b] = [await h.openPull(c.project, draft), await h.openPull(c.project, draft)]
      expect(b).toEqual(a)
      expect(await h.findPull(c.project, head)).toEqual(a)
      git('push', '-q', 'origin', `:${head}`)
    },
    120_000,
  )
})
