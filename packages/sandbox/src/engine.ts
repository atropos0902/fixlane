import { type IncomingMessage, request } from 'node:http'

export class DockerError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(`docker: ${status}: ${message}`)
    this.status = status
  }
}

const socketPath = (process.env.DOCKER_HOST ?? 'unix:///var/run/docker.sock').replace(/^unix:\/\//, '')

/** Talks to the engine's own API. A `docker` process per container would outlive a killed daemon. */
function call(method: string, path: string, body?: unknown): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = payload
      ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
      : {}
    const req = request({ socketPath, method, path, headers }, resolve)
    req.on('error', reject)
    req.end(payload)
  })
}

async function text(res: IncomingMessage): Promise<string> {
  const parts: Buffer[] = []
  for await (const p of res) parts.push(p as Buffer)
  return Buffer.concat(parts).toString('utf8')
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await call(method, path, body)
  const t = await text(res)
  const status = res.statusCode ?? 0
  if (status >= 400) {
    let message = t
    try {
      message = (JSON.parse(t) as { message: string }).message
    } catch {}
    throw new DockerError(status, message)
  }
  return (t === '' ? undefined : t.startsWith('{') || t.startsWith('[') ? JSON.parse(t) : t) as T
}

export interface ContainerInfo {
  Id: string
  Names: string[]
  Labels: Record<string, string>
  State: string
}

export interface Inspect {
  Id: string
  State: { Status: string; Running: boolean; ExitCode: number; OOMKilled: boolean }
}

export const enc = encodeURIComponent

export const list = (labels: Record<string, string>): Promise<ContainerInfo[]> => {
  const label = Object.entries(labels).map(([k, v]) => `${k}=${v}`)
  return api('GET', `/containers/json?all=1&filters=${enc(JSON.stringify({ label }))}`)
}

export async function inspect(name: string): Promise<Inspect | null> {
  try {
    return await api<Inspect>('GET', `/containers/${enc(name)}/json`)
  } catch (e) {
    if (e instanceof DockerError && e.status === 404) return null
    throw e
  }
}

export async function remove(name: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await api('DELETE', `/containers/${enc(name)}?force=1&v=1`)
      return
    } catch (e) {
      if (!(e instanceof DockerError)) throw e
      if (e.status === 404) return
      // 409: somebody else is removing it already. Come back and see.
      if (e.status !== 409 || i > 50) throw e
      await new Promise((r) => setTimeout(r, 100))
      if ((await inspect(name)) === null) return
    }
  }
}

/** stdout of a container from its first line, whether it is still running or not. */
export async function* logs(name: string, follow: boolean): AsyncGenerator<string> {
  const res = await call('GET', `/containers/${enc(name)}/logs?stdout=1&follow=${follow ? 1 : 0}`)
  if ((res.statusCode ?? 0) >= 400) throw new DockerError(res.statusCode ?? 0, await text(res))
  let buf = Buffer.alloc(0)
  let line = Buffer.alloc(0)
  for await (const d of res) {
    buf = Buffer.concat([buf, d as Buffer])
    // Frames: 1 byte stream, 3 bytes nothing, 4 bytes length.
    while (buf.length >= 8) {
      const n = buf.readUInt32BE(4)
      if (buf.length < 8 + n) break
      line = Buffer.concat([line, buf.subarray(8, 8 + n)])
      buf = buf.subarray(8 + n)
      let at = line.indexOf(10)
      while (at >= 0) {
        yield line.subarray(0, at).toString('utf8')
        line = line.subarray(at + 1)
        at = line.indexOf(10)
      }
    }
  }
  if (line.length > 0) yield line.toString('utf8')
}

/** Runs a command in a container and waits for it. Its output is dropped. */
export async function exec(name: string, cmd: string[]): Promise<number> {
  const { Id } = await api<{ Id: string }>('POST', `/containers/${enc(name)}/exec`, { Cmd: cmd })
  await api('POST', `/exec/${Id}/start`, { Detach: true })
  for (;;) {
    const s = await api<{ Running: boolean; ExitCode: number }>('GET', `/exec/${Id}/json`)
    if (!s.Running) return s.ExitCode
    await new Promise((r) => setTimeout(r, 25))
  }
}
