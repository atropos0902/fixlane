// From one desktop appending an entry to another one having it.
// usage: node bench/latency.ts [entries]
import { writeFileSync } from 'node:fs'
import { Db, SyncClient, SyncServer } from '@fixlane/sync'
import { filed, freshDb, Hosted, Memory, repo, Service, said } from '../packages/sync/test/help.ts'

const count = Number(process.argv[2] ?? 2000)
const h = await new Hosted().start()
const first = await freshDb()
const server = new SyncServer({
  service: new Service(new Db(first.url), { github: h.gh() }),
  users: { sam: 'token-of-sam-0123456789', kim: 'token-of-kim-0123456789' },
  port: 0,
})
await first.close()
await server.start()
const [a, b] = [new Memory(), new Memory()]
const sam = new SyncClient(server.origin, 'token-of-sam-0123456789', a)
const kim = new SyncClient(server.origin, 'token-of-kim-0123456789', b)
sam.connect()
kim.connect()
await sam.addRepo(repo)
sam.append(filed('sec-1'))
const sent = new Map<string, number>()
const took: number[] = []
kim.on('entries', (es) => {
  for (const e of es) {
    const t = 'clientId' in e ? sent.get(e.clientId) : undefined
    if (t !== undefined) took.push(performance.now() - t)
  }
})
await new Promise((r) => setTimeout(r, 500))
for (let i = 0; i < count; i++) {
  const d = said('sec-1', `entry ${i}`)
  sent.set(d.clientId, performance.now())
  sam.append(d)
  await new Promise((r) => setTimeout(r, 5))
}
while (took.length < count) await new Promise((r) => setTimeout(r, 20))
took.sort((x, y) => x - y)
const at = (q: number): number => Math.round(took[Math.floor((took.length - 1) * q)]! * 10) / 10
const result = { entries: count, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: at(1) }
writeFileSync(new URL('results/latency.json', import.meta.url), `${JSON.stringify(result, null, 2)}\n`)
console.log(result)
sam.disconnect()
kim.disconnect()
await server.close()
h.stop()
process.exit(0)
