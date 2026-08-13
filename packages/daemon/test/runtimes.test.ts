import { FakeModels, type Turn } from '@fixlane/fakes'
import { afterEach, expect, test } from 'vitest'
import { FIX, NEW_TEST, ticket, World } from './world.ts'

let w: World
let models: FakeModels
afterEach(async () => {
  await w.close()
  models.close()
})

const b64 = (s: string): string => Buffer.from(s).toString('base64')
const CMD = `cat AGENTS.md CLAUDE.md 2>/dev/null; echo ${b64(FIX)} | base64 -d > src/join.js && echo ${b64(NEW_TEST)} | base64 -d > test/inside.test.js && node --test`

const go = async (runtime: 'claude' | 'codex', turns: Turn[]) => {
  models = await new FakeModels(turns).listen()
  const up = (headers: Record<string, string>) => ({ url: models.origin, headers })
  w = await World.make('pr', {
    anthropic: up({ 'x-api-key': 'real-key' }),
    openai: up({ authorization: 'Bearer real-key' }),
  })
  const t = ticket()
  w.store.putTicket(t)
  const s = w.engine.submit(t, runtime)
  const end = await w.engine.settled(s.id)
  const lines = w.store.lines(s.id).map((l) => l.line)
  return { end, lines, sent: JSON.stringify(models.calls.map((c) => c.body)) }
}

// The real SDKs and their command line tools, in the container, with a scripted model behind the proxy.
test.each([
  [
    'claude',
    [
      { tool: 'mcp__ticket__read_ticket', input: {} },
      { tool: 'Bash', input: { command: CMD, description: 'fix' } },
      { text: 'Fixed it.' },
    ],
  ],
  [
    'codex',
    [
      { tool: 'mcp__ticket__/read_ticket', input: {} },
      { tool: 'exec_command', input: { cmd: CMD } },
      { text: 'Fixed it.' },
    ],
  ],
] as ['claude' | 'codex', Turn[]][])(
  '%s works a ticket through to a pull request',
  async (runtime, turns) => {
    const { end, lines, sent } = await go(runtime, turns)
    expect(lines.filter((l) => l.t === 'end')).toEqual([{ t: 'end', ok: true }])
    expect(end).toMatchObject({ state: 'in_review', attempt: 1, reason: null })
    expect(lines.some((l) => l.t === 'text' && l.text === 'Fixed it.')).toBe(true)
    expect(sent).toContain('join() leaves its root.')
    expect(models.calls.every((c) => (c.auth ?? '').endsWith('real-key'))).toBe(true)
    expect(end.tokensIn).toBeGreaterThanOrEqual(3000)
    expect(sent).not.toContain('real-key')
  },
  90_000,
)

test.each([
  ['claude', { tool: 'mcp__ticket__stop', input: { reason: 'join already refuses that' } }],
  ['codex', { tool: 'mcp__ticket__/stop', input: { reason: 'join already refuses that' } }],
] as ['claude' | 'codex', Turn][])(
  '%s can stop',
  async (runtime, turn) => {
    const { end } = await go(runtime, [turn])
    expect(end).toMatchObject({ state: 'stopped', reason: 'join already refuses that' })
  },
  90_000,
)
