/** One test as the reporter in the check container saw it. */
export interface TestResult {
  file: string
  name: string
  outcome: 'pass' | 'fail' | 'skip'
  /** true when the test failed on an assertion, and not because something could not be loaded or called */
  assertion: boolean
}

export interface TestRun {
  results: TestResult[]
  exit: number | null
}

export const keyOf = (t: TestResult): string => `${t.file} > ${t.name}`

const outcomes = (runs: readonly TestRun[]): Map<string, TestResult[]> => {
  const m = new Map<string, TestResult[]>()
  for (const r of runs) for (const t of r.results) m.set(keyOf(t), [...(m.get(keyOf(t)) ?? []), t])
  return m
}

const firmly = (ts: TestResult[] | undefined, n: number, f: (t: TestResult) => boolean): boolean =>
  ts !== undefined && ts.length === n && ts.every(f)

export interface Evidence {
  ok: boolean
  why: string
  /** tests that fail on base and pass on the branch, every time */
  proof: string[]
}

/**
 * `base` is the base commit with the branch's test files copied over it. A test proves the fix when it
 * fails there on an assertion, in every run, and passes on the branch, in every run.
 */
export function judgeProof(base: readonly TestRun[], head: readonly TestRun[]): Evidence {
  const no = (why: string): Evidence => ({ ok: false, why, proof: [] })
  if (base.length === 0 || head.length === 0) return no('the tests were not run')
  if (head.some((r) => r.exit !== 0)) return no('the tests do not pass on the branch')
  const b = outcomes(base)
  const h = outcomes(head)
  const proof = [...h]
    .filter(([k, ts]) => {
      const passes = firmly(ts, head.length, (t) => t.outcome === 'pass')
      return passes && firmly(b.get(k), base.length, (t) => t.outcome === 'fail' && t.assertion)
    })
    .map(([k]) => k)
  if (proof.length > 0) return { ok: true, why: '', proof }

  const all = [...b.values()].flat()
  if (all.some((t) => t.outcome === 'fail' && !t.assertion)) {
    return no(
      'the new test fails on base only because it cannot load or call something, so it proves nothing',
    )
  }
  if (all.some((t) => t.outcome === 'fail'))
    return no('the new test does not give the same result every time')
  return no('every test passes on the base commit too')
}

/** The suite as it was on base, run against the branch's code. Everything that passed must still pass. */
export function judgeSuite(base: TestRun, head: TestRun): string | null {
  const now = outcomes([head])
  const passing = base.results.filter((t) => t.outcome === 'pass')
  if (passing.length === 0) return 'the suite on base has no passing test to compare with'
  const broken = passing.filter((t) => !firmly(now.get(keyOf(t)), 1, (x) => x.outcome === 'pass'))
  return broken.length > 0 ? `breaks ${broken.slice(0, 3).map(keyOf).join('; ')}` : null
}
