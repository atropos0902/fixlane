import fc from 'fast-check'
import { describe, expect, test } from 'vitest'
import {
  advance,
  BadMove,
  type Happening,
  isOver,
  MAX_ATTEMPTS,
  type Progress,
  START,
} from '../src/machine.ts'
import { SESSION_STATES, type SessionState } from '../src/schema.ts'

const pull = { number: 7, url: 'http://h/7', head: 'fix/t/1', state: 'open' as const }
const ALL: Happening[] = [
  { type: 'leased', epoch: 3 },
  { type: 'cloned' },
  { type: 'agent.finished' },
  { type: 'agent.stopped', reason: 'already fixed' },
  { type: 'agent.failed', error: 'model error' },
  { type: 'checks.passed' },
  { type: 'checks.failed', why: 'no proof', retry: true },
  { type: 'checks.failed', why: 'too big', retry: false },
  { type: 'branch.pushed' },
  { type: 'pull.opened', pull },
  { type: 'pull.merged' },
  { type: 'pull.closed' },
  { type: 'lease.lost' },
  { type: 'cancelled', by: 'sam' },
]
const at = (state: SessionState, attempt = 1): Progress => ({ ...START, state, attempt, epoch: 3 })
const go = (state: SessionState, h: Happening, attempt = 1): Progress => advance(at(state, attempt), h)

describe('moves', () => {
  test('the straight way through to a merge', () => {
    let p = START
    const seen = [p.state]
    for (const h of [ALL[0]!, ALL[1]!, ALL[2]!, ALL[5]!, ALL[9]!, ALL[10]!]) {
      p = advance(p, h)
      seen.push(p.state)
    }
    expect(seen).toEqual(['queued', 'cloning', 'running', 'checking', 'proposing', 'in_review', 'done'])
    expect(p).toEqual({ ...START, state: 'done', epoch: 3, pull, outcome: 'merged' })
  })

  test('branch only ends without a pull request', () => {
    expect(go('proposing', { type: 'branch.pushed' })).toEqual({ ...at('done'), outcome: 'branch' })
  })

  test('an agent that stops is a result, with its reason', () => {
    expect(go('running', ALL[3]!)).toEqual({ ...at('stopped'), reason: 'already fixed' })
  })

  test('a failed check goes round again with the reason, until attempts run out', () => {
    const second = go('checking', ALL[6]!)
    expect(second).toEqual({ ...at('cloning', 2), feedback: 'no proof' })
    const last = go('checking', ALL[6]!, MAX_ATTEMPTS)
    expect(last.state).toBe('stopped')
    expect(last.reason).toBe('gave up after 2 attempts: no proof')
    expect(last.attempt).toBe(MAX_ATTEMPTS)
  })

  test('a failure that a retry cannot help with stops at once', () => {
    expect(go('checking', ALL[7]!)).toEqual({ ...at('stopped'), reason: 'too big' })
  })

  test('an agent error is retried the same way', () => {
    expect(go('running', ALL[4]!)).toEqual({ ...at('cloning', 2), feedback: 'model error' })
    expect(go('running', ALL[4]!, MAX_ATTEMPTS).state).toBe('stopped')
  })

  test('closing, losing the lease and cancelling all say why', () => {
    expect(go('in_review', ALL[11]!).reason).toBe('the pull request was closed without merging')
    expect(go('running', ALL[12]!).reason).toBe('another desktop took this ticket')
    expect(go('checking', ALL[13]!).reason).toBe('cancelled by sam')
  })
})

test('every state takes exactly these happenings', () => {
  const table = Object.fromEntries(
    SESSION_STATES.map((s) => [
      s,
      [
        ...new Set(
          ALL.filter((h) => {
            try {
              go(s, h)
              return true
            } catch (e) {
              expect(e).toBeInstanceOf(BadMove)
              expect((e as Error).message).toBe(`${h.type} is not possible in ${s}`)
              return false
            }
          }).map((h) => h.type),
        ),
      ],
    ]),
  )
  expect(table).toEqual({
    queued: ['leased', 'cancelled'],
    cloning: ['cloned', 'lease.lost', 'cancelled'],
    running: ['agent.finished', 'agent.stopped', 'agent.failed', 'lease.lost', 'cancelled'],
    checking: ['checks.passed', 'checks.failed', 'lease.lost', 'cancelled'],
    proposing: ['branch.pushed', 'pull.opened', 'lease.lost', 'cancelled'],
    in_review: ['pull.merged', 'pull.closed', 'cancelled'],
    done: [],
    stopped: [],
  })
})

test('whatever happens, a session ends once, says why it stopped, and stays within its attempts', () => {
  fc.assert(
    fc.property(fc.array(fc.constantFrom(...ALL), { maxLength: 60 }), (hs) => {
      let p = START
      for (const h of hs) {
        if (isOver(p.state)) {
          expect(() => advance(p, h)).toThrow(BadMove)
          continue
        }
        try {
          p = advance(p, h)
        } catch (e) {
          expect(e).toBeInstanceOf(BadMove)
        }
        expect(p.attempt).toBeLessThanOrEqual(MAX_ATTEMPTS)
        expect(p.state === 'stopped').toBe(p.reason !== null)
        expect(p.state === 'done').toBe(p.outcome !== null)
        if (p.state !== 'queued' && p.state !== 'stopped') expect(p.epoch).toBe(3)
      }
    }),
    { numRuns: 2000 },
  )
})

test('isOver', () => {
  expect(SESSION_STATES.filter(isOver)).toEqual(['done', 'stopped'])
})
