import { readFileSync } from 'node:fs'
import { connect, createServer } from 'node:net'
import { type Adapter, type Line, MODEL_PORT, PACKAGE_PORT, type Spec } from './adapter.ts'

const emit = (l: Line): void => void process.stdout.write(`${JSON.stringify(l)}\n`)

/** The container has no network. These two ports lead to the daemon's proxies, through sockets it mounted. */
const forward = (port: number, socket: string): void => {
  createServer((c) => {
    const s = connect(socket)
    c.pipe(s).pipe(c)
    c.on('error', () => s.destroy())
    s.on('error', () => c.destroy())
  }).listen(port, '127.0.0.1')
}
forward(MODEL_PORT, '/session/net/model.sock')
forward(PACKAGE_PORT, '/session/net/packages.sock')

const adapters: Record<Spec['runtime'], () => Promise<Adapter>> = {
  claude: async () => (await import('./adapters/claude.ts')).claude,
  codex: async () => (await import('./adapters/codex.ts')).codex,
  replay: async () => (await import('./adapters/replay.ts')).replay,
}

const over = new AbortController()
process.on('SIGTERM', () => over.abort())
let end: Line = { t: 'end', ok: true }
try {
  const spec = JSON.parse(readFileSync('/session/spec.json', 'utf8')) as Spec
  await (await adapters[spec.runtime]()).run(spec, emit, over.signal)
} catch (e) {
  end = { t: 'end', ok: false, error: e instanceof Error ? e.message : String(e) }
}
emit(end)
// Whatever the agent left running goes down with the container.
process.exit(end.t === 'end' && end.ok ? 0 : 1)
