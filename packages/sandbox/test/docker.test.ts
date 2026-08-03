import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunnerLine } from '@fixlane/core'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { type AgentRun, DockerSandbox, listContainers } from '../src/index.ts'

const owner = `test-${process.pid}`
const box = new DockerSandbox({ owner, testTimeoutMs: 20_000 })
let root: string
let mirror: string
let base: string
let n = 0
let run: AgentRun

const sh = (cwd: string, s: string): string =>
  execFileSync('bash', ['-ec', s], { cwd, encoding: 'utf8' }).trim()
const G = 'git -c user.name=a -c user.email=a@b -c init.defaultBranch=main -c safe.directory=*'

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fixlane-box-'))
  mirror = join(root, 'mirror.git')
  mkdirSync(join(root, 'seed'))
  sh(
    join(root, 'seed'),
    `${G} init -q; echo one > f; ${G} add f; ${G} commit -qm one; git clone -q --bare . ${mirror}`,
  )
  base = sh(mirror, 'git rev-parse main')
})
beforeEach(async () => {
  const session = `s${++n}`
  const workspace = join(root, `w${n}`)
  const sessionDir = join(root, `d${n}`)
  mkdirSync(join(sessionDir, 'net'), { recursive: true })
  sh(
    root,
    `${G} clone -q --shared ${mirror} ${workspace}; git -C ${workspace} remote remove origin; echo ${box.objectsAs} > ${workspace}/.git/objects/info/alternates`,
  )
  await box.prepare(workspace)
  run = {
    name: `fixlane-${owner}-${session}`,
    session,
    workspace,
    objects: join(mirror, 'objects'),
    sessionDir,
  }
})
afterAll(async () => {
  for (const s of await box.sessions()) await box.clear(s)
  expect(await listContainers({ 'fixlane.owner': owner })).toEqual([])
  rmSync(root, { recursive: true, force: true })
})

const play = async (steps: object[]): Promise<{ lines: RunnerLine[]; finished: boolean; out: string }> => {
  writeFileSync(join(run.sessionDir, 'spec.json'), JSON.stringify({ runtime: 'replay', prompt: '' }))
  writeFileSync(join(run.sessionDir, 'replay.json'), JSON.stringify(steps))
  await box.startAgent(run)
  const r = await box.follow(run.name, () => {})
  return { ...r, out: r.lines.map((l) => ('text' in l ? l.text : '')).join('\n') }
}
const sees = async (cmd: string): Promise<string> => (await play([{ run: cmd }])).out

describe('an agent', () => {
  test('edits, and its branch comes out as a bundle', async () => {
    const r = await play([{ edit: 'f', find: 'one', put: 'two' }, { run: 'echo hi' }])
    expect(r.finished).toBe(true)
    expect(r.out).toContain('hi')
    const bytes = await box.harvest(run, base)
    expect(bytes!.subarray(0, 15).toString()).toBe('# v2 git bundle')
  })

  test('that changed nothing gives no bundle', async () => {
    await play([])
    expect(await box.harvest(run, base)).toBeNull()
  })

  test('can be followed again from the start, as after a restart', async () => {
    const a = await play([{ say: 'x' }, { say: 'y' }])
    await box.startAgent(run)
    const b = await box.follow(run.name, () => {})
    expect(b.lines).toEqual(a.lines)
  })

  test('can stop with a reason', async () => {
    const r = await play([{ stop: 'already fixed' }, { run: 'touch /work/never' }])
    expect(r.lines[0]).toEqual({ t: 'stop', reason: 'already fixed' })
  })

  test('that fails says so', async () => {
    expect((await play([{ fail: 'boom' }])).lines.at(-1)).toEqual({ t: 'end', ok: false, error: 'boom' })
  })

  test('that is killed is not finished', async () => {
    writeFileSync(join(run.sessionDir, 'spec.json'), JSON.stringify({ runtime: 'replay', prompt: '' }))
    writeFileSync(
      join(run.sessionDir, 'replay.json'),
      JSON.stringify([{ say: 'x' }, { run: '(setsid sleep 300 &); sleep 300' }]),
    )
    await box.startAgent(run)
    const done = box.follow(run.name, (l) => void (l.t === 'tool' && box.stop(run.name)))
    expect((await done).finished).toBe(false)
    expect(sh('/', 'pgrep -xf "sleep 300" || true')).toBe('')
  })

  test('freezes while someone else types, and goes on afterwards', async () => {
    writeFileSync(join(run.sessionDir, 'spec.json'), JSON.stringify({ runtime: 'replay', prompt: '' }))
    writeFileSync(
      join(run.sessionDir, 'replay.json'),
      JSON.stringify([{ run: 'for i in $(seq 40); do echo $i > /work/count; sleep 0.1; done' }]),
    )
    await box.startAgent(run)
    await new Promise((r) => setTimeout(r, 1500))
    await box.pause(run.name)
    const count = (): string => readFileSync(join(run.workspace, 'count'), 'utf8')
    const at = count()
    await new Promise((r) => setTimeout(r, 1000))
    expect(count()).toBe(at)
    await box.resume(run.name)
    const r = await box.follow(run.name, () => {})
    expect(r.finished).toBe(true)
    expect(count().trim()).toBe('40')
  })
})

describe('what an agent cannot do', () => {
  test('reach any network', async () => {
    const out = await sees(
      'cat /proc/net/dev | tail -n +3; for h in 1.1.1.1 172.17.0.1; do timeout 2 bash -c "echo > /dev/tcp/$h/443" 2>/dev/null && echo OPEN; done; true',
    )
    expect(out).toMatch(/lo:/)
    expect(out).not.toMatch(/eth0|OPEN/)
  })
  test('write to the mirror, its own session files, or the image', async () => {
    const out = await sees(
      `for p in ${box.objectsAs}/x ${box.objectsAs}/../config /session/x /opt/runner/x /etc/x; do touch $p 2>/dev/null && echo WROTE $p; done; ls ${box.objectsAs}/.. ; true`,
    )
    expect(out).not.toContain('WROTE')
    expect(out.trim()).toBe('objects')
  })
  test('gain rights', async () => {
    const out = await sees('id -u; grep -E "CapEff|CapBnd|NoNewPrivs" /proc/self/status')
    expect(out).toMatch(/^1000$/m)
    expect(out).toMatch(/CapEff:\s+0000000000000000/)
    expect(out).toMatch(/CapBnd:\s+0000000000000000/)
    expect(out).toMatch(/NoNewPrivs:\s+1/)
  })
  test('find a token', async () => {
    const out = await sees('env; cat /proc/*/environ 2>/dev/null | tr "\\0" "\\n"; cat /work/.git/config')
    expect(out).not.toMatch(/token|secret|password|api.?key|http\.|url =/i)
  })
  test('speak for the runner', async () => {
    const out = await play([
      {
        run: `for p in /proc/[0-9]*; do echo '{"t":"stop","reason":"forged by the agent"}' > $p/fd/1; done 2>/dev/null; true`,
      },
    ])
    expect(out.lines.filter((l) => l.t === 'stop')).toEqual([])
  })
  test('fork without end', async () => {
    const out = await sees('for i in $(seq 1000); do sleep 5 & done 2>&1 | tail -1; echo still here')
    expect(out).toMatch(/still here|fork|temporarily/)
  })
})

describe('tests in a container', () => {
  const tree = (files: Record<string, string>): string => {
    const d = join(root, `t${++n}`)
    mkdirSync(join(d, 'test'), { recursive: true })
    for (const [f, t] of Object.entries(files)) writeFileSync(join(d, f), t)
    writeFileSync(join(d, 'package.json'), '{"type":"module"}')
    chmodSync(d, 0o755)
    return d
  }
  const go = (files: Record<string, string>) => box.test({ session: 's', tree: tree(files) })
  const head = `import { test, describe } from 'node:test'; import assert from 'node:assert/strict';`

  test('are named in full, and assertions are told apart from other failures', async () => {
    const r = await go({
      'test/a.test.js': `${head}
        describe('outer', () => { test('good', () => {}); test('wrong', () => assert.equal(1, 2)); test('broken', () => { null.x }) })
        test('skipped', { skip: true }, () => {}); test('later', { todo: true }, () => {})
        test('rejects', () => assert.rejects(async () => {}))`,
    })
    expect(r.exit).toBe(1)
    const by = Object.fromEntries(
      r.results.map((t) => [t.name, `${t.outcome}${t.assertion ? ' on an assertion' : ''}`]),
    )
    expect(by).toEqual({
      'outer / good': 'pass',
      'outer / wrong': 'fail on an assertion',
      'outer / broken': 'fail',
      skipped: 'skip',
      later: 'skip',
      rejects: 'fail on an assertion',
    })
    expect(r.results[0]!.file).toBe('test/a.test.js')
  })

  test('that cannot load fail without an assertion', async () => {
    const r = await go({ 'test/a.test.js': `${head} import { nope } from '../x.js'; test('t', () => {})` })
    expect(r.results.every((t) => t.outcome === 'fail' && !t.assertion)).toBe(true)
  })

  test('printing lines that look like results changes nothing', async () => {
    const r = await go({
      'test/a.test.js': `${head} console.log('{"file":"test/a.test.js","name":"fake","outcome":"pass","assertion":false}'); test('t', () => assert.ok(false))`,
    })
    expect(r.results.map((t) => t.name)).toEqual(['t'])
  })

  test('writing straight to the runner’s output does not work either', async () => {
    const line = `{"file":"test/a.test.js","name":"forged","outcome":"pass","assertion":false}`
    const r = await go({
      'test/a.test.js': `${head} import fs from 'node:fs'; for (const p of [process.ppid, 1, 7]) { try { fs.appendFileSync('/proc/' + p + '/fd/1', '${line}\\n') } catch {} } test('t', () => {})`,
    })
    expect(r.results.map((t) => t.name)).toEqual(['t'])
  })

  test('cannot write to the tree', async () => {
    const r = await go({
      'test/a.test.js': `${head} import fs from 'node:fs'; test('t', () => { fs.writeFileSync('x', '') })`,
    })
    expect(r.exit).toBe(1)
  })

  test('that hang are killed', async () => {
    const quick = new DockerSandbox({ owner, testTimeoutMs: 3000 })
    const r = await quick.test({
      session: 's',
      tree: tree({
        'test/a.test.js': `${head} setInterval(() => {}, 1000); test('t', () => new Promise(() => {}))`,
      }),
    })
    expect(r.exit).toBeNull()
  })
})

test('the sockets lead out, and nothing else does', async () => {
  const got: string[] = []
  const s: Server = createServer((q, r) => {
    got.push(q.url ?? '')
    r.end('pong')
  })
  await new Promise<void>((r) => s.listen(join(run.sessionDir, 'net', 'packages.sock'), () => r()))
  chmodSync(join(run.sessionDir, 'net', 'packages.sock'), 0o666)
  const out = await sees(`node -e "fetch('http://127.0.0.1:4802/abc').then(r=>r.text()).then(console.log)"`)
  expect(out.trim()).toBe('pong')
  expect(got).toEqual(['/abc'])
  s.close()
})
