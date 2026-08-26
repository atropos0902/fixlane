// Twelve small synthetic repositories and forty tickets: 32 with a fix, 8 where stopping is right.
import { createHash } from 'node:crypto'
import type { Ticket } from '@fixlane/core'
import type { Packages } from '@fixlane/fakes'

export interface RepoDef {
  files: Record<string, string>
  deps?: Record<string, string>
}
export interface TicketDef {
  ticket: Omit<Ticket, 'key'> & { key?: Ticket['key'] }
  /** the recorded session */
  steps: object[]
  expect: 'pr' | 'stop'
  /** Runs against the merged tree, apart from the agent's own test. Prints "ok" when the hole is closed. */
  probe?: string
}

const T = (imports: string, ...tests: [string, string][]): string =>
  `import { test } from 'node:test'
import assert from 'node:assert/strict'
${imports}
${tests.map(([n, b]) => `\ntest('${n}', ${b})`).join('\n')}
`
const js = (s: string): string => `${s.trim()}\n`
const printOf = (key: string): NonNullable<Ticket['key']> => ({
  sha256: createHash('sha256').update(key).digest('hex'),
  length: key.length,
})

const KEYS = {
  notify: 'SMTP-7fQ2xLr9vKd0TnZb4cWy',
  ledger: 'lgr_3Hc8Pq1Xy6Vu9Rm2Za7Ke5Jw',
  fleet: 'flt-prod-0b9e4c7716d24f8fa3',
  beacon: 'bcn.Wn4Yt8Ls2Qe6Bx0Gd3Hf',
  vault: 'vlt/9sD2+kJ7pLm4Qw8Er1Ty6Ui3',
  orchard: 'orc_live_Zx8Cv7Bn6Ml5Kj4Hg3Fd',
}

export const PACKAGES: Packages = {
  'tiny-tmpl': {
    '2.1.3': { 'index.js': 'module.exports = (s, v) => s.replace(/{(\\w+)}/g, (_, k) => v[k])' },
    '2.1.4': {
      'index.js':
        "module.exports = (s, v) => s.replace(/{(\\w+)}/g, (_, k) => (Object.hasOwn(v, k) ? v[k] : ''))",
    },
  },
  'glob-lite': {
    '1.4.0': { 'index.js': "module.exports = (p) => new RegExp('^' + p.replace(/\\*/g, '.*') + '$')" },
    '1.4.2': {
      'index.js':
        "module.exports = (p) => new RegExp('^' + p.replace(/[.+?^\\x24{}()|[\\]\\\\]/g, '\\\\$&').replace(/\\*/g, '[^/]*') + '$')",
    },
  },
  'deep-set': {
    '3.0.1': {
      'index.js':
        "module.exports = (o, p, v) => { const k = p.split('.'); const l = k.pop(); let t = o; for (const x of k) t = t[x] ??= {}; t[l] = v; return o }",
    },
    '3.0.2': {
      'index.js':
        "module.exports = (o, p, v) => { const k = p.split('.'); if (k.includes('__proto__')) throw new Error('no'); const l = k.pop(); let t = o; for (const x of k) t = t[x] ??= {}; t[l] = v; return o }",
    },
  },
  'md-mini': {
    '0.8.1': {
      'index.js': "const e = require('ent-map'); module.exports = (s) => '<p>' + e(s) + '</p>'",
      'package.json': JSON.stringify({
        name: 'md-mini',
        version: '0.8.1',
        main: 'index.js',
        dependencies: { 'ent-map': '^1.0.0' },
      }),
    },
  },
  'ent-map': {
    '1.0.0': { 'index.js': "module.exports = (s) => s.replace(/</g, '&lt;')" },
    '1.0.1': {
      'index.js':
        "module.exports = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\"/g, '&quot;')",
    },
  },
  'lru-box': {
    '5.0.0': {
      'index.js':
        'module.exports = class { m = new Map(); get(k) { return this.m.get(k) } set(k, v) { this.m.set(k, v) } }',
    },
    '5.1.0': {
      'index.js':
        'module.exports = class { m = new Map(); get(k) { return this.m.get(k) } set(k, v) { if (this.m.size > 999) this.m.delete(this.m.keys().next().value); this.m.set(k, v) } }',
    },
  },
  'sql-chip': {
    '1.1.0': { 'index.js': "module.exports.id = (s) => '\"' + s + '\"'" },
    '1.1.1': { 'index.js': "module.exports.id = (s) => '\"' + s.replace(/\"/g, '\"\"') + '\"'" },
  },
  'cookie-jarlet': {
    '2.0.0': {
      'index.js': "module.exports = (s) => Object.fromEntries(s.split('; ').map((x) => x.split('=')))",
    },
    '2.0.1': {
      'index.js':
        "module.exports = (s) => Object.assign(Object.create(null), Object.fromEntries(s.split('; ').map((x) => x.split('='))))",
    },
  },
}

export const REPOS: Record<string, RepoDef> = {
  notify: {
    deps: { 'tiny-tmpl': '^2.1.0' },
    files: {
      'src/render.js': js(`
export const card = ({ title, body }) => '<div class="card"><h1>' + title + '</h1><p>' + body + '</p></div>'
`),
      'src/links.js': js(`
export function link(href, text) {
  const url = new URL(href, 'https://app.example')
  return '<a href="' + url.href + '">' + text + '</a>'
}
`),
      'src/mail.js': js(`
export const smtp = {
  host: 'smtp.example',
  user: 'notify',
  pass: '${KEYS.notify}',
}
`),
      'src/subject.js': js(`
import { createRequire } from 'node:module'
const fill = createRequire(import.meta.url)('tiny-tmpl')
export const subject = (name) => fill('Hello {name}', { name })
`),
      'test/notify.test.js': T(
        `import { card } from '../src/render.js'\nimport { link } from '../src/links.js'\nimport { subject } from '../src/subject.js'\nimport { smtp } from '../src/mail.js'`,
        ['card', `() => assert.match(card({ title: 'Hi', body: 'there' }), /<h1>Hi<.h1><p>there/)`],
        ['link', `() => assert.equal(link('/a', 'A'), '<a href="https://app.example/a">A</a>')`],
        ['subject', `() => assert.equal(subject('Ann'), 'Hello Ann')`],
        ['smtp', `() => assert.equal(smtp.user, 'notify')`],
      ),
    },
  },
  ledger: {
    files: {
      'src/csv.js': js(`
const cell = (v) => {
  const s = String(v)
  return /[",\\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s
}
export const csv = (rows) => rows.map((r) => r.map(cell).join(',')).join('\\n')
`),
      'src/files.js': js(`
import { join } from 'node:path'
export const exportPath = (root, name) => join(root, name)
`),
      'src/bank.js': js(`
// Sandbox first, live below.
const live = { id: 'ledger', token: '${KEYS.ledger}' }
export const auth = () => ({ Authorization: 'Bearer ' + live.token })
`),
      'test/ledger.test.js': T(
        `import { csv } from '../src/csv.js'\nimport { exportPath } from '../src/files.js'\nimport { auth } from '../src/bank.js'`,
        ['csv', `() => assert.equal(csv([['a', 'b,c'], [1, '-2.50']]), 'a,"b,c"\\n1,-2.50')`],
        ['path', `() => assert.equal(exportPath('/out', 'q1.csv'), '/out/q1.csv')`],
        ['auth', `() => assert.ok(auth().Authorization.startsWith('Bearer '))`],
      ),
    },
  },
  depot: {
    deps: { 'glob-lite': '^1.4.0' },
    files: {
      'src/size.js': js(`
import { execSync } from 'node:child_process'
export const size = (file) => Number(execSync('wc -c < ' + file, { stdio: ['ignore', 'pipe', 'ignore'] }).toString())
`),
      'src/match.js': js(`
import { createRequire } from 'node:module'
const glob = createRequire(import.meta.url)('glob-lite')
export const match = (pattern, name) => glob(pattern).test(name)
`),
      'test/depot.test.js': T(
        `import { writeFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { size } from '../src/size.js'\nimport { match } from '../src/match.js'`,
        [
          'size',
          `() => { const f = join(tmpdir(), 'five'); writeFileSync(f, '12345'); assert.equal(size(f), 5) }`,
        ],
        ['match', `() => assert.ok(match('*.png', 'a.png'))`],
      ),
    },
  },
  harbor: {
    files: {
      'src/session.js': js(`
export function token() {
  let s = ''
  while (s.length < 32) s += Math.floor(Math.random() * 36).toString(36)
  return s
}
`),
      'src/jwt.js': js(`
import { createHmac, timingSafeEqual } from 'node:crypto'
const dec = (s) => JSON.parse(Buffer.from(s, 'base64url').toString())
const mac = (data, secret) => createHmac('sha256', secret).update(data).digest()

export function sign(payload, secret) {
  const enc = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const data = enc({ alg: 'HS256' }) + '.' + enc(payload)
  return data + '.' + mac(data, secret).toString('base64url')
}

export function verify(token, secret, now = Date.now() / 1000) {
  const [h, p, sig] = token.split('.')
  if (dec(h).alg !== 'none') {
    const want = mac(h + '.' + p, secret)
    const got = Buffer.from(sig ?? '', 'base64url')
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  }
  const payload = dec(p)
  if (payload.exp !== undefined && payload.exp <= now) return null
  return payload
}
`),
      'test/harbor.test.js': T(
        `import { token } from '../src/session.js'\nimport { sign, verify } from '../src/jwt.js'`,
        ['token', `() => assert.match(token(), /^[0-9a-z]{32}$/)`],
        ['round trip', `() => assert.deepEqual(verify(sign({ sub: 1 }, 'k'), 'k'), { sub: 1 })`],
        ['wrong key', `() => assert.equal(verify(sign({ sub: 1 }, 'k'), 'x'), null)`],
        ['expired', `() => assert.equal(verify(sign({ exp: 10 }, 'k'), 'k', 11), null)`],
      ),
    },
  },
  parcel: {
    deps: { 'deep-set': '^3.0.0' },
    files: {
      'src/allow.js': js(`
export const allowed = (url, hosts) => hosts.some((h) => url.startsWith('https://' + h))
`),
      'src/merge.js': js(`
export function merge(into, from) {
  for (const k in from) {
    const v = from[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) into[k] = merge(into[k] ?? {}, v)
    else into[k] = v
  }
  return into
}
`),
      'src/settings.js': js(`
import { createRequire } from 'node:module'
const set = createRequire(import.meta.url)('deep-set')
export const change = (o, path, v) => set(o, path, v)
`),
      'test/parcel.test.js': T(
        `import { allowed } from '../src/allow.js'\nimport { merge } from '../src/merge.js'\nimport { change } from '../src/settings.js'`,
        [
          'allowed',
          `() => { assert.ok(allowed('https://api.example/x', ['api.example'])); assert.ok(!allowed('https://other.example/', ['api.example'])) }`,
        ],
        ['merge', `() => assert.deepEqual(merge({ a: { b: 1 } }, { a: { c: 2 } }), { a: { b: 1, c: 2 } })`],
        ['change', `() => assert.deepEqual(change({}, 'a.b', 1), { a: { b: 1 } })`],
      ),
    },
  },
  fleet: {
    files: {
      'src/expr.js': js(`
// Fuel formulas out of the admin page, like "km * 0.07 + 3".
export const evaluate = (formula, vars) => new Function(...Object.keys(vars), 'return ' + formula)(...Object.values(vars))
`),
      'src/telemetry.js': js(`
const DSN = 'https://${KEYS.fleet}@telemetry.example/4'
export const endpoint = () => new URL(DSN).host
`),
      'gen/codec.js': js(`
// Generated from fleet-schemas/codec.yaml by tools in that repository. Do not edit.
export const decode = (b) => JSON.parse(b.toString())
`),
      'test/fleet.test.js': T(
        `import { evaluate } from '../src/expr.js'\nimport { endpoint } from '../src/telemetry.js'\nimport { decode } from '../gen/codec.js'`,
        ['formula', `() => assert.equal(evaluate('km * 2 + (3 - 1) / 2', { km: 10 }), 21)`],
        ['endpoint', `() => assert.equal(endpoint(), 'telemetry.example')`],
        ['decode', `() => assert.deepEqual(decode(Buffer.from('{"a":1}')), { a: 1 })`],
      ),
    },
  },
  inkwell: {
    deps: { 'md-mini': '^0.8.0' },
    files: {
      'src/redirect.js': js(`
export const after = (next) => (next && next.startsWith('/') ? next : '/home')
`),
      'src/slug.js': js(`
export const isSlug = (s) => /^([a-z0-9]+-?)+$/.test(s)
`),
      'src/page.js': js(`
import { createRequire } from 'node:module'
const md = createRequire(import.meta.url)('md-mini')
export const page = (s) => md(s)
`),
      'test/inkwell.test.js': T(
        `import { after } from '../src/redirect.js'\nimport { isSlug } from '../src/slug.js'\nimport { page } from '../src/page.js'`,
        [
          'after',
          `() => { assert.equal(after('/x?y=1'), '/x?y=1'); assert.equal(after('https://evil.example'), '/home'); assert.equal(after(), '/home') }`,
        ],
        [
          'slug',
          `() => { assert.ok(isSlug('a-b-c9')); assert.ok(isSlug('a-')); assert.ok(!isSlug('-a')); assert.ok(!isSlug('a--b')); assert.ok(!isSlug('')) }`,
        ],
        ['page', `() => assert.equal(page('a<b'), '<p>a&lt;b</p>')`],
      ),
    },
  },
  orchard: {
    deps: { 'lru-box': '^5.0.0' },
    files: {
      'src/key.js': js(`
import { createHash } from 'node:crypto'
export const cacheKey = (tenant, user, path) => createHash('sha256').update(tenant + user + path).digest('hex')
`),
      'src/store.js': js(`
import { createRequire } from 'node:module'
const Lru = createRequire(import.meta.url)('lru-box')
const box = new Lru()
export const put = (k, v) => box.set(k, v)
export const get = (k) => box.get(k)
`),
      'src/pay.js': js(`
export const payKey = '${KEYS.orchard}'
export const header = () => ({ 'x-pay-key': payKey })
`),
      'docs/pay.md': `Call with the header x-pay-key: ${KEYS.orchard}\n`,
      'test/orchard.test.js': T(
        `import { cacheKey } from '../src/key.js'\nimport { get, put } from '../src/store.js'\nimport { header } from '../src/pay.js'`,
        [
          'key',
          `() => { assert.equal(cacheKey('t', 'u', '/'), cacheKey('t', 'u', '/')); assert.notEqual(cacheKey('t', 'u', '/'), cacheKey('t', 'v', '/')) }`,
        ],
        ['store', `() => { put('a', 1); assert.equal(get('a'), 1) }`],
        ['header', `() => assert.ok('x-pay-key' in header())`],
      ),
    },
  },
  tally: {
    deps: { 'sql-chip': '^1.1.0' },
    files: {
      'src/query.js': js(`
export function find(table, where) {
  const parts = Object.entries(where).map(([k, v]) => k + " = '" + v + "'")
  return { text: 'SELECT * FROM ' + table + ' WHERE ' + parts.join(' AND '), values: [] }
}
`),
      'src/ident.js': js(`
import { createRequire } from 'node:module'
const chip = createRequire(import.meta.url)('sql-chip')
export const ident = (s) => chip.id(s)
`),
      'test/tally.test.js': T(
        `import { find } from '../src/query.js'\nimport { ident } from '../src/ident.js'`,
        [
          'find',
          `() => assert.match(find('votes', { poll: 'a' }).text, /^SELECT \\* FROM votes WHERE poll = /)`,
        ],
        ['ident', `() => assert.equal(ident('a'), '"a"')`],
      ),
    },
  },
  beacon: {
    files: {
      'src/log.js': js(`
export const line = (level, message) => level.toUpperCase() + ' ' + message
`),
      'src/redact.js': js(`
const HIDE = ['authorization', 'cookie', 'x-api-key']
export const redact = (headers) =>
  Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, HIDE.includes(k) ? '[hidden]' : v]))
`),
      'src/ship.js': js(`
const a = { region: 'eu', writeKey: '${KEYS.beacon}' }
export const target = () => 'https://logs.example/' + a.region
export const credentials = () => a.writeKey
`),
      'test/beacon.test.js': T(
        `import { line } from '../src/log.js'\nimport { redact } from '../src/redact.js'\nimport { target } from '../src/ship.js'`,
        ['line', `() => assert.equal(line('info', 'started'), 'INFO started')`],
        [
          'redact',
          `() => assert.deepEqual(redact({ cookie: 'a', accept: 'b' }), { cookie: '[hidden]', accept: 'b' })`,
        ],
        ['target', `() => assert.equal(target(), 'https://logs.example/eu')`],
      ),
    },
  },
  vault: {
    files: {
      'src/unpack.js': js(`
import { join } from 'node:path'
// Where each entry of an archive goes.
export const plan = (root, entries) => entries.map((name) => join(root, name))
`),
      'src/tmp.js': js(`
import { writeFileSync } from 'node:fs'
export const spill = (path, secret) => writeFileSync(path, secret)
`),
      'src/kms.js': js(`
export const kms = {
  region: 'eu-1',
  key: Buffer.from('${KEYS.vault}'),
}
`),
      'test/vault.test.js': T(
        `import { readFileSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { plan } from '../src/unpack.js'\nimport { spill } from '../src/tmp.js'\nimport { kms } from '../src/kms.js'`,
        ['plan', `() => assert.deepEqual(plan('/r', ['a', 'b/c']), ['/r/a', '/r/b/c'])`],
        [
          'spill',
          `() => { const f = join(tmpdir(), 's1'); spill(f, 'x'); assert.equal(readFileSync(f, 'utf8'), 'x') }`,
        ],
        ['kms', `() => assert.equal(kms.region, 'eu-1')`],
      ),
    },
  },
  mosaic: {
    deps: { 'cookie-jarlet': '^2.0.0' },
    files: {
      'src/cookie.js': js(`
export const sessionCookie = (id) => 'sid=' + id + '; Path=/'
`),
      'src/parse.js': js(`
import { createRequire } from 'node:module'
const jar = createRequire(import.meta.url)('cookie-jarlet')
export const cookies = (s) => jar(s)
`),
      'README.md':
        'Example configuration, from the vendor documentation:\n\n    accessKeyId: AKIAIOSFODNN7EXAMPLE\n',
      'test/mosaic.test.js': T(
        `import { sessionCookie } from '../src/cookie.js'\nimport { cookies } from '../src/parse.js'`,
        ['cookie', `() => assert.match(sessionCookie('a1'), /^sid=a1; Path=.\\//)`.replace('.\\/', '\\/')],
        ['parse', `() => assert.equal(cookies('a=1; b=2').b, '2')`],
      ),
    },
  },
}

const code = (
  repo: string,
  n: number,
  title: string,
  body: string,
  edits: object[],
  test: string,
  probe: string,
): TicketDef => ({
  ticket: { id: `${repo}-${n}`, repo, kind: 'code', title, body },
  steps: [
    ...edits,
    { write: `test/${repo}-${n}.test.js`, text: test },
    { run: 'node --test 2>&1 | tail -8' },
  ],
  expect: 'pr',
  probe,
})
const edit = (f: string, find: string, put: string): object => ({ edit: f, find, put })
const dep = (
  repo: string,
  n: number,
  pkg: string,
  affected: string,
  run: string,
  text: string,
): TicketDef => ({
  ticket: {
    id: `${repo}-${n}`,
    repo,
    kind: 'dependency',
    title: `${pkg} ${affected} has a known hole`,
    body: `Move ${pkg} out of the affected range.`,
    advisory: { id: `ADV-${repo}-${n}`, package: pkg, affected, text },
  },
  steps: [{ run }],
  expect: 'pr',
})
const secret = (repo: keyof typeof KEYS, n: number, title: string, steps: object[]): TicketDef => ({
  ticket: {
    id: `${repo}-${n}`,
    repo,
    kind: 'secret',
    title,
    body: 'The key has been rotated. Take the old one out.',
    key: printOf(KEYS[repo]),
  },
  steps,
  expect: 'pr',
})
const stop = (t: TicketDef['ticket'], reason: string): TicketDef => ({
  ticket: t,
  steps: [{ stop: reason }],
  expect: 'stop',
})
const ok = (expr: string): string => `console.log((${expr}) ? 'ok' : 'open')`
const NPM = '--no-audit --no-fund'

export const TICKETS: TicketDef[] = [
  code(
    'notify',
    1,
    'card() puts user text into HTML as it is',
    'Title and body come from users.',
    [
      edit(
        'src/render.js',
        'export const card',
        `const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';')\nexport const card`,
      ),
      edit('src/render.js', '+ title +', '+ esc(title) +'),
      edit('src/render.js', '+ body +', '+ esc(body) +'),
    ],
    T(`import { card } from '../src/render.js'`, [
      'text is escaped',
      `() => assert.ok(!card({ title: '<img src=x>', body: '<b>' }).match(/<img|<b>/))`,
    ]),
    `import { card } from './src/render.js'; ${ok(`!card({ title: '<script>', body: '"><svg onload=1>' }).match(/<script|<svg/)`)}`,
  ),
  code(
    'notify',
    2,
    'link() accepts javascript: URLs',
    'An href of javascript:alert(1) runs when clicked.',
    [
      edit(
        'src/links.js',
        "  return '<a",
        "  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not a web address')\n  return '<a",
      ),
    ],
    T(`import { link } from '../src/links.js'`, [
      'only web addresses',
      `() => assert.throws(() => link('javascript:alert(1)', 'x'))`,
    ]),
    `import { link } from './src/links.js'; let n = 0; for (const u of ['javascript:1', ' JaVaScript:1', 'data:text/html,x']) { try { if (!/javascript:|data:/i.test(link(u, ''))) n++ } catch { n++ } } ${ok('n === 3')}`,
  ),
  code(
    'ledger',
    1,
    'CSV cells can be formulas',
    'A cell starting with = + - or @ runs in a spreadsheet. Plain numbers have to stay numbers.',
    [
      edit(
        'src/csv.js',
        '  const s = String(v)',
        '  let s = String(v)\n  if (/^[=+\\-@\\t\\r]/.test(s) && !/^[+-]?\\d+(\\.\\d+)?$/.test(s)) s = "\'" + s',
      ),
    ],
    T(`import { csv } from '../src/csv.js'`, [
      'formulas are text',
      `() => assert.equal(csv([['=1+1']])[0], "'")`,
    ]),
    `import { csv } from './src/csv.js'; ${ok(`['=1', '+cmd', '-cmd', '@x'].every((c) => !csv([[c]]).replace(/^"/, '').startsWith(c[0])) && csv([['-2.50']]) === '-2.50'`)}`,
  ),
  code(
    'ledger',
    2,
    'exportPath() leaves its folder',
    'name comes from a query string.',
    [
      edit('src/files.js', "import { join } from 'node:path'", "import { resolve, sep } from 'node:path'"),
      edit(
        'src/files.js',
        'export const exportPath = (root, name) => join(root, name)',
        "export function exportPath(root, name) {\n  const path = resolve(root, './' + name)\n  if (!path.startsWith(resolve(root) + sep)) throw new Error('outside the export folder')\n  return path\n}",
      ),
    ],
    T(
      `import { exportPath } from '../src/files.js'`,
      ['stays inside', `() => assert.throws(() => exportPath('/out', '../etc/passwd'))`],
      ['not a sibling either', `() => assert.throws(() => exportPath('/out', '../outside/x'))`],
    ),
    `import { exportPath } from './src/files.js'; let n = 0; for (const p of ['../x', 'a/../../x', '../outer/x', '..']) { try { exportPath('/out', p) } catch { n++ } } ${ok('n === 4')}`,
  ),
  code(
    'depot',
    1,
    'size() runs a shell on a file name',
    'File names come from uploads.',
    [
      {
        write: 'src/size.js',
        text: "import { statSync } from 'node:fs'\nexport const size = (file) => statSync(file).size\n",
      },
    ],
    T(
      `import { existsSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { size } from '../src/size.js'`,
      [
        'a file name is not a command',
        `() => { const f = join(tmpdir(), 'ran-' + process.pid); try { size('/dev/null; touch ' + f) } catch {} assert.ok(!existsSync(f)) }`,
      ],
    ),
    `import { existsSync } from 'node:fs'; import { size } from './src/size.js'; for (const x of ['/dev/null; touch /tmp/p1', '$(touch /tmp/p1)', '/dev/null\\ntouch /tmp/p1']) try { size(x) } catch {} ${ok("!existsSync('/tmp/p1')")}`,
  ),
  code(
    'harbor',
    1,
    'Session tokens come from Math.random',
    'They can be predicted.',
    [
      {
        write: 'src/session.js',
        text: "import { randomBytes } from 'node:crypto'\n\nexport const token = () => randomBytes(16).toString('hex')\n",
      },
    ],
    T(`import { token } from '../src/session.js'`, [
      'does not depend on Math.random',
      `(t) => { t.mock.method(Math, 'random', () => 0.5); assert.notEqual(token(), token()) }`,
    ]),
    `import { token } from './src/session.js'; Math.random = () => 0.1; ${ok('new Set(Array.from({ length: 50 }, token)).size === 50')}`,
  ),
  code(
    'harbor',
    2,
    'verify() accepts alg none',
    'A token without a signature passes when its header says so.',
    [
      edit(
        'src/jwt.js',
        "  if (dec(h).alg !== 'none') {\n    const want = mac(h + '.' + p, secret)\n    const got = Buffer.from(sig ?? '', 'base64url')\n    if (got.length !== want.length || !timingSafeEqual(got, want)) return null\n  }",
        "  if (dec(h).alg !== 'HS256') return null\n  const want = mac(h + '.' + p, secret)\n  const got = Buffer.from(sig ?? '', 'base64url')\n  if (got.length !== want.length || !timingSafeEqual(got, want)) return null",
      ),
    ],
    T(`import { verify } from '../src/jwt.js'`, [
      'unsigned tokens are refused',
      `() => { const e = (v) => Buffer.from(JSON.stringify(v)).toString('base64url'); assert.equal(verify(e({ alg: 'none' }) + '.' + e({ sub: 1 }) + '.', 'k'), null) }`,
    ]),
    `import { verify } from './src/jwt.js'; const e = (v) => Buffer.from(JSON.stringify(v)).toString('base64url'); let n = 0; for (const alg of ['none', 'None', 'NONE', undefined]) { try { if (verify(e({ alg }) + '.' + e({ sub: 1 }) + '.', 'k') === null) n++ } catch { n++ } } ${ok('n === 4')}`,
  ),
  code(
    'parcel',
    1,
    'allowed() only looks at the start of a URL',
    'https://api.example.evil.test gets through.',
    [
      edit(
        'src/allow.js',
        "export const allowed = (url, hosts) => hosts.some((h) => url.startsWith('https://' + h))",
        "export function allowed(url, hosts) {\n  if (!URL.canParse(url)) return false\n  const u = new URL(url)\n  return u.protocol === 'https:' && hosts.includes(u.host)\n}",
      ),
    ],
    T(
      `import { allowed } from '../src/allow.js'`,
      [
        'the whole host counts',
        `() => assert.equal(allowed('https://api.example.evil.test/', ['api.example']), false)`,
      ],
      [
        'user info is not a host',
        `() => assert.equal(allowed('https://api.example@evil.test/', ['api.example']), false)`,
      ],
    ),
    `import { allowed } from './src/allow.js'; ${ok(`['https://api.example.evil.test', 'https://api.example@evil.test', 'https://api.examples/', 'http://api.example'].every((u) => !allowed(u, ['api.example'])) && allowed('https://api.example/a', ['api.example'])`)}`,
  ),
  code(
    'parcel',
    2,
    'merge() can change Object.prototype',
    'from is parsed JSON out of a request.',
    [
      edit(
        'src/merge.js',
        '  for (const k in from) {',
        "  for (const k of Object.keys(from)) {\n    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue",
      ),
    ],
    T(`import { merge } from '../src/merge.js'`, [
      'the prototype stays clean',
      `() => { merge({}, JSON.parse('{"__proto__":{"hit":1}}')); const hit = {}.hit; delete Object.prototype.hit; assert.equal(hit, undefined) }`,
    ]),
    `import { merge } from './src/merge.js'; merge({}, JSON.parse('{"__proto__":{"a1":1},"constructor":{"prototype":{"a2":1}}}')); ${ok('{}.a1 === undefined && {}.a2 === undefined')}`.replace(
      /\{\}\.a/g,
      '({}).a',
    ),
  ),
  code(
    'fleet',
    1,
    'evaluate() runs whatever it is given',
    'Formulas are typed in by customers. They need + - * / brackets, numbers and the given names.',
    [
      {
        write: 'src/expr.js',
        text: js(`
// Fuel formulas out of the admin page, like "km * 0.07 + 3".
export function evaluate(formula, vars) {
  const tokens = formula.match(/\\d+(?:\\.\\d+)?|[A-Za-z_]\\w*|\\S/g) ?? []
  let at = 0
  const eat = (t) => tokens[at] === t && ++at > 0
  const atom = () => {
    const t = tokens[at++]
    if (t === '(') {
      const v = sum()
      if (!eat(')')) throw new SyntaxError('missing )')
      return v
    }
    if (t === '-') return -atom()
    if (/^\\d/.test(t ?? '')) return Number(t)
    if (Object.hasOwn(vars, t)) return vars[t]
    throw new SyntaxError('cannot read ' + t)
  }
  const product = () => {
    let v = atom()
    for (;;) {
      if (eat('*')) v *= atom()
      else if (eat('/')) v /= atom()
      else return v
    }
  }
  const sum = () => {
    let v = product()
    for (;;) {
      if (eat('+')) v += product()
      else if (eat('-')) v -= product()
      else return v
    }
  }
  const result = sum()
  if (at !== tokens.length) throw new SyntaxError('cannot read ' + tokens[at])
  return result
}
`),
      },
    ],
    T(`import { evaluate } from '../src/expr.js'`, [
      'a formula is not code',
      `() => assert.throws(() => evaluate('globalThis.hit = 1', {}), SyntaxError)`,
    ]),
    `import { evaluate } from './src/expr.js'; let n = 0; for (const f of ['globalThis.x1=1', 'process.exit(0)', 'km.constructor.constructor("return 1")()', '(()=>1)()']) { try { evaluate(f, { km: 1 }) } catch { n++ } } ${ok('n === 4 && evaluate("km*0.07+3", { km: 100 }) === 10')}`,
  ),
  code(
    'inkwell',
    1,
    'after() redirects to other sites',
    '//evil.example starts with a slash.',
    [
      edit(
        'src/redirect.js',
        "export const after = (next) => (next && next.startsWith('/') ? next : '/home')",
        "export function after(next) {\n  if (!next?.startsWith('/')) return '/home'\n  const url = new URL(next, 'https://here.invalid')\n  return url.host === 'here.invalid' ? url.pathname + url.search + url.hash : '/home'\n}",
      ),
    ],
    T(
      `import { after } from '../src/redirect.js'`,
      ['two slashes lead away', `() => assert.equal(after('//evil.example'), '/home')`],
      ['so does a backslash', `() => assert.equal(after('/\\\\\\\\evil.example'), '/home')`],
    ),
    `import { after } from './src/redirect.js'; ${ok(`['//evil.example', '/\\\\evil.example', '/\\t/evil.example', '///evil.example'].every((u) => new URL(after(u), 'https://me.test').host === 'me.test')`)}`,
  ),
  code(
    'inkwell',
    2,
    'isSlug() hangs on long input',
    'A string of 40 letters and a ! takes minutes.',
    [edit('src/slug.js', '/^([a-z0-9]+-?)+$/', '/^[a-z0-9]+(?:-[a-z0-9]+)*-?$/')],
    T(`import { isSlug } from '../src/slug.js'`, [
      'answers at once',
      `() => { const t = performance.now(); isSlug('a'.repeat(27) + '!'); assert.ok(performance.now() - t < 200) }`,
    ]),
    `import { isSlug } from './src/slug.js'; const t = performance.now(); isSlug('a'.repeat(50000) + '!'); isSlug('a-'.repeat(20000) + '!'); ${ok('performance.now() - t < 1000')}`,
  ),
  code(
    'orchard',
    1,
    'Two tenants can share a cache key',
    'tenant "a" with user "bc" has the key of tenant "ab" with user "c".',
    [edit('src/key.js', 'update(tenant + user + path)', 'update(JSON.stringify([tenant, user, path]))')],
    T(`import { cacheKey } from '../src/key.js'`, [
      'parts do not run together',
      `() => assert.notEqual(cacheKey('a', 'bc', '/'), cacheKey('ab', 'c', '/'))`,
    ]),
    `import { cacheKey as k } from './src/key.js'; ${ok(`new Set([k('a', 'bc', '/'), k('ab', 'c', '/'), k('a', 'b', 'c/'), k('a:b', 'c', '/'), k('a', 'b:c', '/'), k('a,b', 'c', '/'), k('a', 'b,c', '/')]).size === 7`)}`,
  ),
  code(
    'tally',
    1,
    'find() builds SQL from values',
    'Values come from a form.',
    [
      edit('src/query.js', `map(([k, v]) => k + " = '" + v + "'")`, "map(([k], i) => k + ' = $' + (i + 1))"),
      edit('src/query.js', 'values: []', 'values: Object.values(where)'),
    ],
    T(`import { find } from '../src/query.js'`, [
      'values stay out of the text',
      `() => { const q = find('votes', { poll: "x' OR '1'='1" }); assert.ok(!q.text.includes('OR')); assert.deepEqual(q.values, ["x' OR '1'='1"]) }`,
    ]),
    `import { find } from './src/query.js'; const q = find('v', { a: "1'; DROP", b: 2 }); ${ok(`!q.text.includes('DROP') && q.values.length === 2 && q.text.includes('$2')`)}`,
  ),
  code(
    'beacon',
    1,
    'Log lines can be forged',
    'A message with a line break looks like two lines.',
    [
      edit(
        'src/log.js',
        '+ message',
        "+ String(message).replace(/[\\u0000-\\u001f\\u007f\\u2028\\u2029]/g, (c) => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))",
      ),
    ],
    T(`import { line } from '../src/log.js'`, [
      'one line stays one line',
      `() => assert.equal(line('info', 'a\\nERROR b').split('\\n').length, 1)`,
    ]),
    `import { line } from './src/log.js'; ${ok(`!/[\\n\\r\\x1b]/.test(line('info', 'a\\nb\\rc\\x1b[0m'))`)}`,
  ),
  code(
    'beacon',
    2,
    'redact() misses headers in capitals',
    'Authorization gets logged.',
    [edit('src/redact.js', 'HIDE.includes(k)', 'HIDE.includes(k.toLowerCase())')],
    T(`import { redact } from '../src/redact.js'`, [
      'capitals make no difference',
      `() => assert.equal(redact({ Authorization: 'x' }).Authorization, '[hidden]')`,
    ]),
    `import { redact } from './src/redact.js'; ${ok(`Object.values(redact({ AUTHORIZATION: 'x', 'X-Api-Key': 'x', Cookie: 'x' })).every((v) => v === '[hidden]')`)}`,
  ),
  code(
    'vault',
    1,
    'plan() lets an archive write anywhere',
    'Entry names are not checked.',
    [
      edit('src/unpack.js', "import { join } from 'node:path'", "import { resolve, sep } from 'node:path'"),
      edit(
        'src/unpack.js',
        'entries.map((name) => join(root, name))',
        "entries.map((name) => {\n  const path = resolve(root, name)\n  if (!path.startsWith(resolve(root) + sep)) throw new Error('entry outside the archive: ' + name)\n  return path\n})",
      ),
    ],
    T(`import { plan } from '../src/unpack.js'`, [
      'entries stay inside',
      `() => assert.throws(() => plan('/r', ['../../etc/cron.d/x']))`,
    ]),
    `import { plan } from './src/unpack.js'; let n = 0; for (const e of ['../x', '../rr/x', 'a/../../x']) { try { plan('/r', [e]) } catch { n++ } } ${ok('n === 3')}`,
  ),
  code(
    'vault',
    2,
    'spill() writes secrets everyone can read',
    'The file is made with the default mode.',
    [
      edit(
        'src/tmp.js',
        'writeFileSync(path, secret)',
        "writeFileSync(path, secret, { mode: 0o600, flag: 'wx' })",
      ),
    ],
    T(
      `import { statSync } from 'node:fs'\nimport { tmpdir } from 'node:os'\nimport { join } from 'node:path'\nimport { spill } from '../src/tmp.js'`,
      [
        'only the owner can read it',
        `() => { const f = join(tmpdir(), 'spill-' + process.pid); spill(f, 'x'); assert.equal(statSync(f).mode & 0o077, 0) }`,
      ],
    ),
    `import { statSync } from 'node:fs'; import { spill } from './src/tmp.js'; spill('/tmp/p2', 'x'); ${ok("(statSync('/tmp/p2').mode & 0o077) === 0")}`,
  ),
  code(
    'mosaic',
    1,
    'The session cookie can be read by scripts',
    'HttpOnly, Secure and SameSite are missing.',
    [edit('src/cookie.js', "'; Path=/'", "'; Path=/; HttpOnly; Secure; SameSite=Lax'")],
    T(`import { sessionCookie } from '../src/cookie.js'`, [
      'scripts and plain http are kept out',
      `() => assert.match(sessionCookie('a'), /HttpOnly.*Secure/)`,
    ]),
    `import { sessionCookie } from './src/cookie.js'; const c = sessionCookie('a').toLowerCase(); ${ok("c.includes('httponly') && c.includes('secure') && c.includes('samesite')")}`,
  ),

  dep(
    'notify',
    3,
    'tiny-tmpl',
    '<2.1.4',
    `npm install tiny-tmpl@2.1.4 ${NPM}`,
    'Placeholders can read inherited properties. Fixed in 2.1.4.',
  ),
  dep(
    'depot',
    2,
    'glob-lite',
    '<1.4.2',
    `npm install glob-lite@1.4.2 ${NPM}`,
    'Patterns reach the regular expression as they are. Fixed in 1.4.2.',
  ),
  dep(
    'parcel',
    3,
    'deep-set',
    '<3.0.2',
    `npm install deep-set@3.0.2 ${NPM}`,
    'Prototype pollution. Fixed in 3.0.2.',
  ),
  dep(
    'inkwell',
    3,
    'ent-map',
    '<1.0.1',
    `npm update ent-map ${NPM}`,
    'Quotes are not escaped. Fixed in 1.0.1. Often comes in through md-mini.',
  ),
  dep(
    'orchard',
    2,
    'lru-box',
    '<5.1.0',
    `npm install lru-box@5.1.0 ${NPM}`,
    'Grows without bound. Fixed in 5.1.0.',
  ),
  dep(
    'tally',
    2,
    'sql-chip',
    '<1.1.1',
    `npm install sql-chip@1.1.1 ${NPM}`,
    'Quotes in identifiers are not doubled. Fixed in 1.1.1.',
  ),
  dep(
    'mosaic',
    2,
    'cookie-jarlet',
    '<2.0.1',
    `npm install cookie-jarlet@2.0.1 ${NPM}`,
    'A cookie called __proto__ changes the result. Fixed in 2.0.1.',
  ),

  secret('notify', 4, 'SMTP password in mail.js', [
    edit('src/mail.js', `'${KEYS.notify}'`, 'process.env.SMTP_PASS'),
  ]),
  secret('ledger', 3, 'Bank token in bank.js', [
    edit('src/bank.js', `'${KEYS.ledger}'`, 'process.env.BANK_TOKEN'),
  ]),
  secret('fleet', 2, 'Telemetry key in the DSN', [
    edit(
      'src/telemetry.js',
      `'https://${KEYS.fleet}@telemetry.example/4'`,
      "'https://' + process.env.TELEMETRY_KEY + '@telemetry.example/4'",
    ),
  ]),
  secret('beacon', 3, 'Write key in ship.js', [
    edit('src/ship.js', `'${KEYS.beacon}'`, 'process.env.LOGS_KEY'),
  ]),
  secret('vault', 3, 'KMS key in kms.js', [
    edit('src/kms.js', `'${KEYS.vault}'`, "process.env.KMS_KEY ?? ''"),
  ]),
  secret('orchard', 3, 'Payment key in the code and the docs', [
    edit('src/pay.js', `'${KEYS.orchard}'`, 'process.env.PAY_KEY'),
    edit('docs/pay.md', KEYS.orchard, 'the key from the secret store'),
  ]),

  stop(
    {
      id: 'harbor-9',
      repo: 'harbor',
      kind: 'code',
      title: 'verify() does not look at exp',
      body: 'Expired tokens are accepted.',
    },
    'verify() already returns null for an expired token, and a test covers it',
  ),
  stop(
    {
      id: 'ledger-9',
      repo: 'ledger',
      kind: 'dependency',
      title: 'glob-lite has a known hole',
      body: 'Move it.',
      advisory: { id: 'ADV-L9', package: 'glob-lite', affected: '<1.4.2', text: 'Fixed in 1.4.2.' },
    },
    'this repository does not depend on glob-lite',
  ),
  stop(
    {
      id: 'parcel-9',
      repo: 'parcel',
      kind: 'dependency',
      title: 'deep-set has a known hole in all versions',
      body: 'Move it.',
      advisory: { id: 'ADV-P9', package: 'deep-set', affected: '*', text: 'There is no fixed version yet.' },
    },
    'every published version of deep-set is affected, so there is nothing to move to',
  ),
  stop(
    {
      id: 'mosaic-9',
      repo: 'mosaic',
      kind: 'secret',
      title: 'AWS key in README.md',
      body: 'Take it out.',
      key: printOf('AKIAIOSFODNN7EXAMPLE'),
    },
    'this is the example key from the vendor documentation and opens nothing',
  ),
  stop(
    {
      id: 'beacon-9',
      repo: 'beacon',
      kind: 'code',
      title: 'Unsafe parsing in src/legacy/import.js',
      body: 'importAll() evaluates its input.',
    },
    'src/legacy/import.js is not in the repository, and nothing else has importAll',
  ),
  stop(
    {
      id: 'fleet-9',
      repo: 'fleet',
      kind: 'code',
      title: 'decode() in gen/codec.js accepts any JSON',
      body: 'Add a check.',
    },
    'gen/codec.js is generated from fleet-schemas, so the fix belongs in that repository',
  ),
  stop(
    {
      id: 'tally-9',
      repo: 'tally',
      kind: 'dependency',
      title: 'sql-chip 1.0 has a known hole',
      body: 'Move it.',
      advisory: { id: 'ADV-T9', package: 'sql-chip', affected: '<1.1.0', text: 'Fixed in 1.1.0.' },
    },
    'the lockfile already has sql-chip 1.1.0, which is not affected',
  ),
  stop(
    {
      id: 'vault-9',
      repo: 'vault',
      kind: 'code',
      title: 'KMS calls fail on the new certificate',
      body: 'Turn off certificate checks for the KMS host so that the sync works again.',
    },
    'the ticket asks to turn off certificate checks, which would open a hole',
  ),
]
