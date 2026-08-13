import { chmod, rm } from 'node:fs/promises'
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join } from 'node:path'

export interface Upstream {
  /** e.g. https://api.anthropic.com */
  url: string
  headers: Record<string, string>
}

/** Dollars per million tokens. */
export interface Price {
  in: number
  out: number
}

export interface ProxyOptions {
  dir: string
  anthropic: Upstream | null
  openai: Upstream | null
  registry: string
  /** packages the session may ask for by name */
  packages: Iterable<string>
  budget: number
  prices: Record<string, Price>
  spent: () => number
  onUsage: (tokensIn: number, tokensOut: number, costMicros: number) => void
}

const MODEL_PATHS: Record<string, 'anthropic' | 'openai'> = {
  '/v1/messages': 'anthropic',
  '/v1/messages/count_tokens': 'anthropic',
  '/v1/responses': 'openai',
}

const refuse = (res: ServerResponse, status: number, message: string): void => {
  res
    .writeHead(status, { 'content-type': 'application/json' })
    .end(JSON.stringify({ error: { type: 'refused', message } }))
}

const send = (url: URL, o: RequestOptions): ReturnType<typeof httpRequest> =>
  url.protocol === 'https:' ? httpsRequest(url, o) : httpRequest(url, o)

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

/** Reads token counts out of a streamed answer as it goes by. Both vendors put them in the last events. */
class Meter {
  #buf = ''
  tokensIn = 0
  tokensOut = 0
  model = ''
  add(d: Buffer): void {
    this.#buf += d.toString('utf8')
    let at = this.#buf.indexOf('\n')
    while (at >= 0) {
      this.#line(this.#buf.slice(0, at).trim())
      this.#buf = this.#buf.slice(at + 1)
      at = this.#buf.indexOf('\n')
    }
  }
  end(): void {
    this.#line(this.#buf.trim())
    this.#buf = ''
  }
  #line(l: string): void {
    const text = l.startsWith('data:') ? l.slice(5) : l
    if (!text.includes('usage')) return
    try {
      const e = JSON.parse(text) as {
        usage?: Usage
        model?: string
        message?: { usage?: Usage; model?: string }
        response?: { usage?: Usage; model?: string }
      }
      const part = e.message ?? e.response ?? e
      if (part.model) this.model = part.model
      const u = part.usage
      if (!u) return
      const all =
        (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      this.tokensIn = Math.max(this.tokensIn, all)
      this.tokensOut = Math.max(this.tokensOut, u.output_tokens ?? 0)
    } catch {}
  }
}

function model(o: ProxyOptions, req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const vendor = MODEL_PATHS[path]
  if (req.method !== 'POST' || !vendor) return refuse(res, 404, `${req.method} ${path} is not allowed`)
  const up = o[vendor]
  if (!up) return refuse(res, 403, `no key for ${vendor}`)
  if (o.spent() >= o.budget) return refuse(res, 403, 'this session has used up its tokens')

  const url = new URL(up.url.replace(/\/$/, '') + path)
  const headers: Record<string, string | string[]> = { host: url.host }
  for (const [k, v] of Object.entries(req.headers)) {
    // Everything that identifies or routes is ours. `accept-encoding` goes too, so usage stays readable.
    if (v && !['host', 'authorization', 'x-api-key', 'connection', 'accept-encoding'].includes(k))
      headers[k] = v
  }
  const out = send(url, { method: 'POST', headers: { ...headers, ...up.headers } })
  const meter = new Meter()
  out.on('response', (r) => {
    const { connection, 'transfer-encoding': _, ...rest } = r.headers
    res.writeHead(r.statusCode ?? 502, rest)
    r.on('data', (d: Buffer) => {
      meter.add(d)
      res.write(d)
    })
    // Also when the answer breaks off half way: those tokens were spent.
    r.on('close', () => {
      meter.end()
      const price = o.prices[meter.model] ?? { in: 0, out: 0 }
      const [i, n] = [meter.tokensIn, meter.tokensOut]
      if (i + n > 0 && path !== '/v1/messages/count_tokens')
        o.onUsage(i, n, Math.round(i * price.in + n * price.out))
      res.end()
    })
  })
  out.on('error', () => (res.headersSent ? res.destroy() : refuse(res, 502, 'the model did not answer')))
  res.on('close', () => out.destroy())
  req.pipe(out)
}

const NAME = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i
const TARBALL = /^\/((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)\/-\/[\w.+-]+\.tgz$/i

/**
 * A package name is enough to carry a secret out, so only names that are known beforehand go through:
 * the ones in the repository's lockfile, the one in the advisory, and what those depend on.
 */
function packages(o: ProxyOptions, allowed: Set<string>, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://x')
  const path = decodeURIComponent(url.pathname)
  const tarball = TARBALL.exec(path)?.[1]
  const name = tarball ?? path.slice(1)
  if (req.method !== 'GET' || url.search !== '' || !NAME.test(name))
    return refuse(res, 405, 'only plain reads of packages')
  if (!allowed.has(name)) return refuse(res, 403, `${name} is not a package of this repository`)

  const from = new URL(o.registry + (tarball ? path : `/${name.replace('/', '%2f')}`))
  const out = send(from, { method: 'GET', headers: { accept: 'application/json', host: from.host } })
  out.on('response', (r) => {
    const parts: Buffer[] = []
    r.on('data', (d: Buffer) => parts.push(d))
    r.on('end', () => {
      const body = Buffer.concat(parts)
      if (!tarball && r.statusCode === 200) {
        try {
          const doc = JSON.parse(body.toString()) as {
            versions: Record<string, Record<string, Record<string, string>>>
          }
          for (const v of Object.values(doc.versions)) {
            for (const k of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
              for (const n of Object.keys(v[k] ?? {})) allowed.add(n)
            }
          }
        } catch {}
      }
      const type = r.headers['content-type'] ?? 'application/octet-stream'
      res.writeHead(r.statusCode ?? 502, { 'content-type': type }).end(body)
    })
  })
  out.on('error', () => refuse(res, 502, 'the registry did not answer'))
  out.end()
}

/** The two ways out of a container. Both are sockets in a directory that is mounted into it. */
export class Proxies {
  readonly #servers: Server[] = []

  static async open(o: ProxyOptions): Promise<Proxies> {
    const p = new Proxies()
    const allowed = new Set(o.packages)
    await p.#listen(join(o.dir, 'model.sock'), (q, s) => model(o, q, s))
    await p.#listen(join(o.dir, 'packages.sock'), (q, s) => packages(o, allowed, q, s))
    return p
  }

  async #listen(path: string, fn: (q: IncomingMessage, s: ServerResponse) => void): Promise<void> {
    await rm(path, { force: true })
    const server = createServer((q, s) => {
      try {
        fn(q, s)
      } catch {
        refuse(s, 400, 'bad request')
      }
    })
    await new Promise<void>((r, e) => server.once('error', e).listen(path, r))
    await chmod(path, 0o666)
    this.#servers.push(server)
  }

  close(): void {
    for (const s of this.#servers) {
      s.closeAllConnections()
      s.close()
    }
  }
}

export async function registryIntegrity(
  registry: string,
  name: string,
  version: string,
): Promise<string | null> {
  const r = await fetch(`${registry}/${name.replace('/', '%2f')}`, { signal: AbortSignal.timeout(15_000) })
  if (!r.ok) return null
  const doc = (await r.json()) as { versions: Record<string, { dist?: { integrity?: string } }> }
  return doc.versions[version]?.dist?.integrity ?? null
}
