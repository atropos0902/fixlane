import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  checkBump,
  checkRemoval,
  type FileChange,
  findKey,
  hides,
  isLockfile,
  isTest,
  judgeProof,
  judgeSuite,
  needsPerson,
  parseChanges,
  readLock,
  scan,
  type TestResult,
  type TestRun,
} from '../src/index.ts'

const change = (path: string, added = 1, o: Partial<FileChange> = {}): FileChange => ({
  path,
  mode: '100644',
  status: 'M',
  added,
  removed: 0,
  binary: false,
  ...o,
})

describe('what needs a person', () => {
  test.each([
    ['.github/workflows/ci.yml', 'CI'],
    ['.gitlab-ci.yml', 'CI'],
    ['.gitlab/x', 'CI'],
    ['.circleci/config.yml', 'CI'],
    ['.buildkite/p.yml', 'CI'],
    ['Jenkinsfile', 'CI'],
    ['azure-pipelines.yml', 'CI'],
    ['.husky/pre-commit', 'CI'],
    ['.npmrc', 'tools'],
    ['packages/a/.npmrc', 'tools'],
    ['.gitmodules', 'tools'],
    ['sub/.gitattributes', 'tools'],
    ['.yarnrc.yml', 'tools'],
    ['.yarnrc', 'tools'],
  ])('%s', (path, why) => expect(needsPerson([change('src/a.js'), change(path)])).toContain(why))

  test('ordinary paths that look similar do not', () => {
    for (const p of [
      'src/github/x.js',
      'docs/.github.md',
      'src/npmrc.js',
      'src/Jenkinsfile.js',
      'x/.circleci/y',
    ]) {
      expect(needsPerson([change(p)])).toBeNull()
    }
  })

  test('links, submodules, binaries and nothing at all', () => {
    expect(needsPerson([change('a', 0, { mode: '120000' })])).toBe('a is a symlink')
    expect(needsPerson([change('a', 0, { mode: '160000' })])).toBe('a is a submodule')
    expect(needsPerson([change('a', 0, { binary: true })])).toBe('a is binary')
    expect(needsPerson([])).toBe('the branch changes nothing')
  })

  test('200 lines is fine and 201 is not, counting both sides and leaving lockfiles out', () => {
    expect(needsPerson([change('a', 150, { removed: 50 })])).toBeNull()
    expect(needsPerson([change('a', 150, { removed: 51 })])).toBe('the diff is 201 lines, over 200')
    expect(needsPerson([change('a', 100), change('b', 101)])).toContain('201')
    expect(needsPerson([change('package-lock.json', 5000), change('a', 200)])).toBeNull()
  })

  test('lockfiles and tests by name', () => {
    expect(
      ['package-lock.json', 'x/pnpm-lock.yaml', 'yarn.lock', 'npm-shrinkwrap.json'].every(isLockfile),
    ).toBe(true)
    expect(['package-lock.json.js', 'lock', 'my-package-lock.json'].some(isLockfile)).toBe(false)
    expect(
      ['test/a.js', 'a/tests/b.js', 'x/__tests__/y', 'a.test.js', 'b.spec.tsx', 'c.test.mjs'].every(isTest),
    ).toBe(true)
    expect(['src/test.js', 'latest/a.js', 'contest.js', 'a.test.json', 'a.test.js.snap'].some(isTest)).toBe(
      false,
    )
  })
})

test('diff output reads back', () => {
  const raw = ':100644 100644 a b M\0a.js\0:000000 120000 0 c A\0odd\tname\0:100644 000000 a 0 D\0gone\0'
  const num = '3\t1\ta.js\0' + '1\t0\todd\tname\0' + '-\t-\tgone\0'
  expect(parseChanges(raw, num)).toEqual([
    { path: 'a.js', mode: '100644', status: 'M', added: 3, removed: 1, binary: false },
    { path: 'odd\tname', mode: '120000', status: 'A', added: 1, removed: 0, binary: false },
    { path: 'gone', mode: '000000', status: 'D', added: 0, removed: 0, binary: true },
  ])
  expect(parseChanges('', '')).toEqual([])
  expect(() => parseChanges(':100644 100644 a b R100\0x\0', '')).toThrow('cannot read')
})

const advisory = { id: 'ADV-1', package: 'tiny-tmpl', affected: '<2.1.4', text: '' }
const REG = 'https://registry.example/'
const lock = (pkgs: Record<string, object>, v = 3): string =>
  JSON.stringify({ lockfileVersion: v, packages: { '': { name: 'app', version: '1.0.0' }, ...pkgs } })
const p = (version: string, name = 'tiny-tmpl', o: object = {}): object => ({
  version,
  resolved: `${REG}${name}/-/${name}-${version}.tgz`,
  integrity: `sha512-${name}-${version}`,
  ...o,
})
const real = async (n: string, v: string): Promise<string> => `sha512-${n}-${v}`
const bump = (
  base: string,
  head: string,
  integ: typeof real | (() => Promise<null>) = real,
): Promise<string | null> => checkBump(base, head, advisory, REG, integ)

describe('dependency bumps', () => {
  const old = lock({ 'node_modules/tiny-tmpl': p('2.1.3') })
  test('a clean bump', async () => {
    expect(await bump(old, lock({ 'node_modules/tiny-tmpl': p('2.1.4') }))).toBeNull()
  })
  test('removing the package also counts', async () => {
    expect(await bump(old, lock({}))).toBeNull()
  })
  test('not affected on base', async () => {
    const good = lock({ 'node_modules/tiny-tmpl': p('2.1.4') })
    expect(await bump(good, good)).toBe('tiny-tmpl is not at an affected version on base')
    expect(await bump(lock({ 'node_modules/x-tmpl': p('1.0.0', 'x-tmpl') }), good)).toContain(
      'not at an affected',
    )
  })
  test('a nested copy that stayed behind', async () => {
    const head = lock({
      'node_modules/tiny-tmpl': p('2.1.4'),
      'node_modules/a/node_modules/tiny-tmpl': p('2.0.0'),
    })
    expect(await bump(old, head)).toBe('node_modules/a/node_modules/tiny-tmpl@2.0.0 is still affected')
  })
  test('a prerelease of an affected version', async () => {
    expect(await bump(old, lock({ 'node_modules/tiny-tmpl': p('2.1.4-rc.1') }))).toContain('still affected')
  })
  test('another registry, or contents that are not what the registry has', async () => {
    const elsewhere = p('2.1.4', 'tiny-tmpl', { resolved: 'https://evil.example/tiny-tmpl-2.1.4.tgz' })
    expect(await bump(old, lock({ 'node_modules/tiny-tmpl': elsewhere }))).toContain(
      'comes from https://evil',
    )
    const swapped = p('2.1.4', 'tiny-tmpl', { integrity: 'sha512-other' })
    expect(await bump(old, lock({ 'node_modules/tiny-tmpl': swapped }))).toBe(
      'node_modules/tiny-tmpl does not match the registry',
    )
    expect(await bump(old, lock({ 'node_modules/tiny-tmpl': p('2.1.4') }), async () => null)).toContain(
      'does not match',
    )
  })
  test('the same version with a new URL or new contents is looked at again', async () => {
    const other = { 'node_modules/o': p('1.0.0', 'o') }
    const base = lock({ 'node_modules/tiny-tmpl': p('2.1.3'), ...other })
    const moved = (x: object): string =>
      lock({ 'node_modules/tiny-tmpl': p('2.1.4'), 'node_modules/o': p('1.0.0', 'o', x) })
    expect(await bump(base, moved({}))).toBeNull()
    expect(await bump(base, moved({ resolved: 'https://evil.example/o.tgz' }))).toContain('comes from')
    expect(await bump(base, moved({ integrity: 'sha512-z' }))).toContain('does not match')
  })
  test('an entry that was odd before is left alone as long as it did not change', async () => {
    const other = { 'node_modules/o': p('1.0.0', 'o', { resolved: 'https://old.example/o.tgz' }) }
    expect(
      await bump(lock({ 'node_modules/tiny-tmpl': p('2.1.3'), ...other }), lock({ ...other })),
    ).toBeNull()
  })
  test('missing URL or integrity', async () => {
    for (const x of [{ resolved: undefined }, { integrity: undefined }]) {
      expect(await bump(old, lock({ 'node_modules/tiny-tmpl': p('2.1.4', 'tiny-tmpl', x) }))).toContain(
        'no resolved URL',
      )
    }
  })
  test('links and the root are not packages, scoped names keep their scope', () => {
    const l = readLock(
      lock({ 'packages/a': { link: true, version: '1.0.0' }, 'node_modules/@s/x': p('1.0.0', '@s/x') }),
    )
    expect(l.map((x) => x.name)).toEqual(['@s/x'])
    expect(readLock(lock({ 'node_modules/a/node_modules/@s/x': p('1.0.0') }))[0]!.name).toBe('@s/x')
    expect(readLock(lock({}, 2))).toEqual([])
    expect(() => readLock(lock({}, 1))).toThrow('older')
    expect(() => readLock('{"lockfileVersion":3}')).toThrow('older')
  })
})

const KEY = 'k3yMaterial+/0123456789abcdef'
const print = { sha256: createHash('sha256').update(KEY).digest('hex'), length: KEY.length }
const tree = (o: Record<string, string>): Map<string, string> => new Map(Object.entries(o))

describe('removed keys', () => {
  test('a key is found by its hash inside longer text', () => {
    expect(findKey(`const k = "${KEY}";`, print)).toBe(KEY)
    expect(findKey(`url?x=AAAA${KEY}BBBB`, print)).toBe(KEY)
    expect(findKey('nothing here at all', print)).toBeNull()
    expect(findKey(KEY.slice(1), print)).toBeNull()
  })

  test.each([
    ['as it was', `x = '${KEY}'`],
    ['reversed', `x = '${[...KEY].reverse().join('')}'`],
    ['as base64', `x = '${Buffer.from(KEY).toString('base64')}'`],
    ['as base64', `x = '${Buffer.from(KEY).toString('base64url')}'`],
    ['as hex', `x = '${Buffer.from(KEY).toString('hex').toUpperCase()}'`],
    ['in pieces', `x = '${KEY.slice(0, 9)}' +\n  '${KEY.slice(9)}'`],
    ['in pieces', `x = ['${KEY.slice(0, 5)}', '${KEY.slice(5)}'].join('')`.replace("', '", "','")],
  ])('coming back %s', (how, text) => expect(hides(text, KEY)).toBe(how))

  test('base64 with its special letters, with and without padding, in either alphabet', () => {
    for (const key of ['?>?>?>?>?>?>', '?>?>?>?>?>?>x', '?>?>?>?>?>?>xy']) {
      const [a, b] = [Buffer.from(key).toString('base64'), Buffer.from(key).toString('base64url')]
      expect(a.replace(/=/g, '')).not.toBe(b)
      for (const t of [a, a.replace(/=/g, ''), b]) expect(hides(`x = "${t}"`, key)).toBe('as base64')
    }
  })

  test('the key is looked for past the first file', () => {
    const base = tree({ 'a.md': 'nothing', 'b.js': `k = "${KEY}"` })
    expect(checkRemoval(base, tree({ 'b.js': `k = "${KEY}"` }), print)).toContain('still in b.js')
  })

  test('other ways of writing an assigned secret', () => {
    for (const t of [
      'passwd: "0123456789abcdef"',
      'secret="0123456789abcdef"',
      "'token' : '0123456789abcdef'",
      'password =  "0123456789abcdef"',
    ]) {
      expect(scan(tree({ a: t })).length).toBe(1)
    }
    expect(scan(tree({ a: 'tokens = "0123456789abcdef"; token_count = "0123456789abcdef"' }))).toEqual([])
  })

  test('not there', () => expect(hides('const k = process.env.KEY', KEY)).toBeNull())

  test('the whole tree is read', () => {
    const base = tree({ 'a.js': `k = "${KEY}"`, 'b.md': 'x' })
    expect(checkRemoval(base, tree({ 'a.js': 'k = process.env.K', 'b.md': 'x' }), print)).toBeNull()
    expect(checkRemoval(base, tree({ 'a.js': 'k = process.env.K', 'b.md': KEY }), print)).toBe(
      'the key is still in b.md, as it was',
    )
    expect(checkRemoval(tree({ 'a.js': '' }), tree({}), print)).toContain('not in the base tree')
  })

  test('a different key in its place', () => {
    const base = tree({ 'a.js': `k = "${KEY}"`, 'old.js': 'const token = "abcdefghijklmnopqrstu"' })
    const head = (extra: object): Map<string, string> =>
      tree({ 'a.js': '', 'old.js': 'const token = "abcdefghijklmnopqrstu"', ...extra })
    expect(checkRemoval(base, head({}), print)).toBeNull()
    expect(checkRemoval(base, head({ 'n.js': 'password: "correcthorsebattery"' }), print)).toBe(
      'there is a new assigned secret in n.js',
    )
    const twice = 'const token = "abcdefghijklmnopqrstu"; const secret = "abcdefghijklmnopqrstu"'
    expect(checkRemoval(base, head({ 'old.js': twice }), print)).toBe(
      'there is a new assigned secret in old.js',
    )
  })

  test('the scan knows the usual shapes', () => {
    const f = scan(
      tree({
        a: `AKIA${'A'.repeat(16)}`,
        b: '-----BEGIN RSA PRIVATE KEY-----',
        c: `ghp_${'a'.repeat(36)}`,
        d: `xoxb-${'1'.repeat(12)}`,
        e: `sk_live_${'a'.repeat(16)}`,
        f: 'apiKey = "0123456789abcdef"',
        g: 'const apiKey = process.env.API_KEY; password = "short"',
      }),
    )
    expect(f.map((x) => `${x.path} ${x.what}`)).toEqual([
      'a AWS access key',
      'b private key',
      'c GitHub token',
      'd Slack token',
      'e live key',
      'f assigned secret',
    ])
  })
})

const t = (name: string, outcome: TestResult['outcome'] = 'pass', assertion = true): TestResult => ({
  file: 'test/a.test.js',
  name,
  outcome,
  assertion: outcome === 'fail' && assertion,
})
const run = (results: TestResult[], exit = results.some((r) => r.outcome === 'fail') ? 1 : 0): TestRun => ({
  results,
  exit,
})
const ok = run([t('old'), t('new')])
const red = run([t('old'), t('new', 'fail')])

describe('proof', () => {
  test('fails on base and passes on the branch, every time', () => {
    expect(judgeProof([red, red], [ok, ok])).toEqual({ ok: true, why: '', proof: ['test/a.test.js > new'] })
  })
  test.each<[string, TestRun[], TestRun[], string]>([
    ['passes either way', [ok], [ok], 'passes on the base commit too'],
    ['red on the branch', [red], [red], 'do not pass on the branch'],
    ['exits badly on the branch', [red], [run(ok.results, 1)], 'do not pass on the branch'],
    ['killed on the branch', [red], [{ results: ok.results, exit: null }], 'do not pass on the branch'],
    ['cannot load on base', [run([t('new', 'fail', false)])], [ok], 'cannot load or call'],
    ['red once on the branch', [red, red], [ok, red], 'do not pass on the branch'],
    [
      'passing and not loading on base',
      [run([t('old'), t('new', 'fail', false)])],
      [ok],
      'cannot load or call',
    ],
    ['skipped on the branch', [red], [run([t('old'), t('new', 'skip')])], 'same result every time'],
    ['missing on the branch', [red], [run([t('old')])], 'same result every time'],
    ['flaky on base', [red, ok], [ok, ok], 'same result every time'],
    ['flaky on the branch', [red, red], [ok, run([t('old')])], 'same result every time'],
    ['not on base at all', [run([t('old')])], [ok], 'passes on the base commit too'],
    ['never run', [], [ok], 'not run'],
    ['never run', [red], [], 'not run'],
  ])('%s', (_, base, head, why) => {
    const e = judgeProof(base, head)
    expect(e.ok).toBe(false)
    expect(e.proof).toEqual([])
    expect(e.why).toContain(why)
  })
  test('two tests with one name prove nothing', () => {
    const twice = run([t('new', 'fail'), t('new', 'fail')])
    expect(judgeProof([twice], [run([t('new'), t('new')])]).ok).toBe(false)
  })
  test('one proof is enough when another new test proves nothing', () => {
    const base = run([t('new', 'fail'), t('idle')])
    expect(judgeProof([base], [run([t('new'), t('idle')])]).proof).toEqual(['test/a.test.js > new'])
  })
})

describe('suite', () => {
  test('everything that passed still passes', () => {
    expect(judgeSuite(run([t('a'), t('b', 'fail')]), run([t('a'), t('b', 'fail'), t('c')]))).toBeNull()
  })
  test('a test that broke, vanished, is skipped, or ran twice', () => {
    expect(judgeSuite(run([t('a')]), run([t('a', 'fail')]))).toBe('breaks test/a.test.js > a')
    expect(judgeSuite(run([t('a'), t('b')]), run([t('b')]))).toBe('breaks test/a.test.js > a')
    expect(judgeSuite(run([t('a')]), run([t('a', 'skip')]))).toContain('breaks')
    expect(judgeSuite(run([t('a')]), run([t('a'), t('a')]))).toContain('breaks')
  })
  test('names at most three', () => {
    const many = ['a', 'b', 'c', 'd'].map((n) => t(n))
    expect(judgeSuite(run(many), run([]))).toBe(
      'breaks test/a.test.js > a; test/a.test.js > b; test/a.test.js > c',
    )
  })
  test('nothing to compare with', () => {
    expect(judgeSuite(run([t('a', 'fail')]), run([]))).toContain('no passing test')
  })
})
