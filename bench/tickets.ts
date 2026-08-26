// Runs the forty tickets. With a key in the environment, a real agent works them.
// usage: node bench/tickets.ts [replay|claude|codex] [only,these,tickets]
import { writeFileSync } from 'node:fs'
import type { Runtime } from '@fixlane/daemon'
import { Lab } from './lab.ts'
import { TICKETS } from './suite.ts'

const runtime = (process.argv[2] ?? 'replay') as Runtime
const only = process.argv[3]?.split(',')
const key = (name: string, url: string, header: (k: string) => Record<string, string>) => {
  const k = process.env[name]
  return k ? { url, headers: header(k) } : null
}
const prices = JSON.parse(process.env.FIXLANE_PRICES ?? '{}') as Record<string, { in: number; out: number }>
const model = process.env.FIXLANE_MODEL
const lab = await Lab.make({
  concurrency: 3,
  prices,
  ...(model ? { models: { [runtime]: model } } : {}),
  anthropic: key('ANTHROPIC_API_KEY', 'https://api.anthropic.com', (k) => ({ 'x-api-key': k })),
  openai: key('OPENAI_API_KEY', 'https://api.openai.com', (k) => ({ authorization: `Bearer ${k}` })),
})
const started = Date.now()
const rows = await Promise.all(
  TICKETS.filter((t) => !only || only.includes(t.ticket.id)).map(async (d) => {
    const s = await lab.run(d, runtime)
    const got = s.state === 'in_review' ? 'pr' : s.state
    const probe = d.probe && got === 'pr' ? lab.probe(d, s) : null
    const row = {
      id: d.ticket.id,
      kind: d.ticket.kind,
      expect: d.expect,
      got,
      probe,
      attempt: s.attempt,
      reason: s.reason,
      tokensIn: s.tokensIn,
      tokensOut: s.tokensOut,
      cost: s.costMicros / 1e6,
    }
    process.stderr.write(`${row.id} ${row.got} ${row.probe ?? ''} ${row.reason ?? ''}\n`)
    return row
  }),
)
const fix = rows.filter((r) => r.expect === 'pr')
const stop = rows.filter((r) => r.expect === 'stop')
const merged = fix.filter((r) => r.got === 'pr')
const result = {
  runtime,
  fixable: fix.length,
  pullRequests: merged.length,
  acceptedButStillOpen: merged.filter((r) => r.probe !== null && r.probe !== 'ok').map((r) => r.id),
  toStopOn: stop.length,
  stopped: stop.filter((r) => r.got === 'stopped').length,
  costPerPullRequest: merged.length > 0 ? rows.reduce((n, r) => n + r.cost, 0) / merged.length : null,
  seconds: Math.round((Date.now() - started) / 1000),
  rows,
}
const { rows: _, ...top } = result
console.log(top)
if (!only)
  writeFileSync(
    new URL(`results/tickets-${runtime}.json`, import.meta.url),
    `${JSON.stringify(result, null, 2)}\n`,
  )
await lab.close()
process.exit(0)
