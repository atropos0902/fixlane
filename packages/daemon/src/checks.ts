import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  checkBump,
  checkRemoval,
  isTest,
  judgeProof,
  judgeSuite,
  keyOf,
  needsPerson,
  readLock,
  type TestRun,
  type Ticket,
} from '@fixlane/core'
import type { Mirror } from '@fixlane/gitstore'
import type { Sandbox } from '@fixlane/sandbox'
import { Proxies, registryIntegrity } from './proxies.ts'
import type { Verdict } from './store.ts'

const run = promisify(execFile)
const LOCK = 'package-lock.json'

export interface CheckJob {
  mirror: Mirror
  sandbox: Sandbox
  ticket: Ticket
  session: string
  base: string
  head: string
  /** scratch space, emptied afterwards */
  dir: string
  registry: string
  /** how often each side of the proof is run */
  rounds: number
}

const scripts = (text: string | null): string => {
  try {
    const p = JSON.parse(text ?? '{}') as Record<string, unknown>
    return JSON.stringify([p.scripts ?? null, p.bin ?? null, p.workspaces ?? null])
  } catch {
    return 'unreadable'
  }
}

export async function check(j: CheckJob): Promise<Verdict> {
  const runs: Verdict['runs'] = []
  const note = (label: string, r: TestRun): TestRun => {
    runs.push({ label, results: r.results.map((t) => ({ name: keyOf(t), outcome: t.outcome })) })
    return r
  }
  const no = (why: string, retry = true): Verdict => ({ ok: false, why, retry, proof: [], runs })

  const person = needsPerson(await j.mirror.changes(j.base, j.head))
  if (person) return no(person, person === 'the branch changes nothing')
  if (
    scripts(await j.mirror.show(j.base, 'package.json')) !==
    scripts(await j.mirror.show(j.head, 'package.json'))
  ) {
    return no('package.json changes what its scripts do', false)
  }

  const baseLock = await j.mirror.show(j.base, LOCK)
  const headLock = await j.mirror.show(j.head, LOCK)
  if (j.ticket.kind === 'dependency') {
    if (!j.ticket.advisory || !baseLock || !headLock)
      return no('there is no advisory or no lockfile to check against', false)
    let bad: string | null
    try {
      bad = await checkBump(baseLock, headLock, j.ticket.advisory, j.registry, (n, v) =>
        registryIntegrity(j.registry, n, v),
      )
    } catch (e) {
      bad = `the lockfile cannot be read: ${(e as Error).message}`
    }
    if (bad) return no(bad)
  }
  if (j.ticket.kind === 'secret') {
    if (!j.ticket.key) return no('the ticket does not say which key', false)
    const bad = checkRemoval(await j.mirror.texts(j.base), await j.mirror.texts(j.head), j.ticket.key)
    if (bad) return no(bad)
  }

  await rm(j.dir, { recursive: true, force: true })
  await mkdir(j.dir, { recursive: true })
  await chmod(j.dir, 0o755)
  try {
    const at = (name: string): string => join(j.dir, name)
    const testsIn = async (sha: string): Promise<string[]> => (await j.mirror.files(sha)).filter(isTest)
    const [baseTests, headTests] = [await testsIn(j.base), await testsIn(j.head)]

    const install = async (tree: string, lock: string | null): Promise<string | null> => {
      if (!lock || readLock(lock).length === 0) return null
      const net = at(`${tree}.net`)
      await mkdir(net)
      const names = [...readLock(baseLock ?? lock), ...readLock(lock)].map((p) => p.name)
      const proxies = await Proxies.open({
        dir: net,
        anthropic: null,
        openai: null,
        registry: j.registry,
        packages: names,
        budget: 0,
        prices: {},
        spent: () => 0,
        onUsage: () => {},
      })
      try {
        await j.sandbox.prepare(at(tree))
        const r = await j.sandbox.install({ session: j.session, tree: at(tree), net })
        return r.ok ? null : 'npm ci fails with this lockfile'
      } finally {
        proxies.close()
      }
    }

    await j.mirror.unpack(j.base, at('base'))
    await j.mirror.unpack(j.head, at('head'))
    const baseBad = await install('base', baseLock)
    if (baseBad) return no(`on the base commit, ${baseBad}`, false)
    const headBad = await install('head', headLock)
    if (headBad) return no(headBad)

    /** A copy of one side's tree with the other side's tests in it. Hard links, as nothing writes to it. */
    const swap = async (
      tree: string,
      name: string,
      drop: string[],
      sha: string,
      put: string[],
    ): Promise<void> => {
      await run('cp', ['-al', at(tree), at(name)])
      await Promise.all(drop.map((p) => rm(join(at(name), p), { force: true })))
      if (put.length > 0) await j.mirror.unpack(sha, at(name), put)
    }
    const test = (tree: string): Promise<TestRun> => j.sandbox.test({ session: j.session, tree: at(tree) })

    await swap('head', 'head-old-tests', headTests, j.base, baseTests)
    const [before, after] = await Promise.all([test('base'), test('head-old-tests')])
    note('Suite on base', before)
    note('Same suite on the branch', after)
    const broken = judgeSuite(before, after)
    if (broken) return no(broken)

    let proof: string[] = []
    if (j.ticket.kind === 'code') {
      await swap('base', 'base-new-tests', baseTests, j.head, headTests)
      const bases: TestRun[] = []
      const heads: TestRun[] = []
      for (let i = 0; i < j.rounds; i++) {
        const [b, h] = await Promise.all([test('base-new-tests'), test('head')])
        bases.push(b)
        heads.push(h)
      }
      note('New tests on base', bases[0]!)
      note('New tests on the branch', heads[0]!)
      const e = judgeProof(bases, heads)
      if (!e.ok) return no(e.why)
      proof = e.proof
    } else if (headTests.length > 0) {
      const h = note('Tests on the branch', await test('head'))
      if (h.exit !== 0) return no('the tests do not pass on the branch')
    }
    return { ok: true, why: '', retry: false, proof, runs }
  } finally {
    if (existsSync(j.dir)) await rm(j.dir, { recursive: true, force: true })
  }
}
