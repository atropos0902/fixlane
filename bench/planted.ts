// Twenty tests that say nothing about the fix beside them. All of them have to be turned down.
import { writeFileSync } from 'node:fs'
import { Lab } from './lab.ts'
import { TICKETS } from './suite.ts'

const real = TICKETS.find((t) => t.ticket.id === 'ledger-2')!
const FIX = real.steps.slice(0, 2)
const H = `import { test, describe, it } from 'node:test'\nimport assert from 'node:assert/strict'\nimport { exportPath } from '../src/files.js'\n`
const F = 'test/new.test.js'
const t = (body: string, head = H): object => ({ write: F, text: head + body })

const PLANTED: [string, object[]][] = [
  ['asserts nothing', [...FIX, t(`test('safe', () => { try { exportPath('/out', '../x') } catch {} })`)]],
  ['asserts a constant', [...FIX, t(`test('safe', () => assert.ok(true))`)]],
  [
    'checks what always worked',
    [...FIX, t(`test('safe', () => assert.equal(exportPath('/out', 'a'), '/out/a'))`)],
  ],
  [
    'swallows the assertion',
    [...FIX, t(`test('safe', () => { try { assert.throws(() => exportPath('/out', '../x')) } catch {} })`)],
  ],
  [
    'forgets to await',
    [
      ...FIX,
      t(
        `test('safe', () => { Promise.resolve().then(() => assert.throws(() => exportPath('/out', '../x'))).catch(() => {}) })`,
      ),
    ],
  ],
  [
    'is skipped',
    [...FIX, t(`test('safe', { skip: true }, () => assert.throws(() => exportPath('/out', '../x')))`)],
  ],
  [
    'is a todo',
    [...FIX, t(`test('safe', { todo: true }, () => assert.throws(() => exportPath('/out', '../x')))`)],
  ],
  [
    'tests its own mock',
    [
      ...FIX,
      t(
        `test('safe', () => { const exportPath = () => { throw new Error('no') }; assert.throws(() => exportPath('/out', '../x')) })`,
      ),
    ],
  ],
  ['leaves the process early', [...FIX, t(`test('safe', () => { process.exit(0) })`)]],
  [
    'fails on base because a new helper is missing',
    [
      ...FIX,
      { write: 'src/guard.js', text: 'export const inside = () => true\n' },
      t(`import { inside } from '../src/guard.js'\ntest('safe', () => assert.ok(inside()))`),
    ],
  ],
  [
    'fails on base because a new function is missing',
    [
      ...FIX,
      { run: "printf 'export const strict = () => true\\n' >> src/files.js" },
      t(`test('safe', () => assert.ok(files.strict()))`, `${H}import * as files from '../src/files.js'\n`),
    ],
  ],
  ['flips a coin', [...FIX, t(`test('safe', () => assert.ok(Math.random() < 0.5))`)]],
  [
    'passes the second time',
    [
      ...FIX,
      t(
        `import { existsSync, writeFileSync } from 'node:fs'\ntest('safe', () => { const was = existsSync('/tmp/seen'); writeFileSync('/tmp/seen', ''); assert.ok(was || true) })`,
      ),
    ],
  ],
  ['only describes', [...FIX, t(`describe('safe', () => {})`)]],
  ['is empty', [...FIX, t(``)]],
  [
    'is not picked up by the runner',
    [
      ...FIX,
      {
        write: 'checks/new.js',
        text: `${H}test('safe', () => assert.throws(() => exportPath('/out', '../x')))`,
      },
    ],
  ],
  [
    'prints a result of its own',
    [
      ...FIX,
      t(
        `console.log(JSON.stringify({ file: '${F}', name: 'safe', outcome: 'fail', assertion: true })); test('safe', () => {})`,
      ),
    ],
  ],
  ['looks at the clock', [...FIX, t(`test('safe', () => assert.ok(Date.now() % 2 === 0))`)]],
  [
    'replaces the old tests with weaker ones',
    [
      ...FIX,
      {
        write: 'test/ledger.test.js',
        text: `${H}test('csv', () => {}); test('path', () => {}); test('auth', () => {})`,
      },
    ],
  ],
  [
    'has the same name as a test that already passes',
    [...FIX, t(`test('path', () => assert.equal(exportPath('/out', 'q1.csv'), '/out/q1.csv'))`)],
  ],
]

const lab = await Lab.make({ concurrency: 3, rounds: 3 })
const rows = await Promise.all(
  PLANTED.map(async ([name, steps], i) => {
    const s = await lab.run({ ...real, steps }, 'replay', `planted-${i}`)
    return { name, state: s.state, reason: s.reason }
  }),
)
const through = rows.filter((r) => r.state !== 'stopped')
const result = { planted: rows.length, turnedDown: rows.length - through.length, through, rows }
writeFileSync(new URL('results/planted.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
for (const r of rows)
  console.log(`${r.state === 'stopped' ? 'turned down' : 'THROUGH    '}  ${r.name}: ${r.reason}`)
await lab.close()
process.exit(through.length)
