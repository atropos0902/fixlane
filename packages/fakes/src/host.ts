import { execFileSync, spawn } from 'node:child_process'
import { createHmac, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

export interface FakePull {
  number: number
  project: string
  head: string
  base: string
  title: string
  body: string
  state: 'open' | 'closed' | 'merged'
  createdAt: number
}

export type Fault =
  /** does the work, then drops the connection */
  | 'lost-answer'
  | 'error-500'
  /** does the work, then answers 502 */
  | 'done-but-502'
  | 'rate-limit'
  /** GitHub's form: 403, nothing remaining, and a reset time */
  | 'rate-reset'
  /** new pull requests are missing from lists for a while */
  | 'stale-list'

export interface FaultRule {
  fault: Fault
  method: 'GET' | 'POST'
  times: number
}

const read = async (req: IncomingMessage): Promise<Buffer> => {
  const parts: Buffer[] = []
  for await (const p of req) parts.push(p as Buffer)
  return Buffer.concat(parts)
}

/**
 * Speaks enough of GitHub's and GitLab's APIs for the adapters, and serves the repositories over git's
 * own HTTP protocol. It can be told to fail in the ways the real ones do.
 */
export class FakeHost {
  readonly root: string
  readonly token: string
  readonly hookSecret: string
  readonly pulls: FakePull[] = []
  readonly faults: FaultRule[] = []
  /** every request that carried a wrong token or none */
  readonly refused: string[] = []
  readonly #server: Server
  #stale = 0

  constructor(root: string, token = 'host-token', hookSecret = 'hook-secret') {
    this.root = root
    this.token = token
    this.hookSecret = hookSecret
    mkdirSync(root, { recursive: true })
    this.#server = createServer((q, s) => {
      this.#handle(q, s).catch((e: Error) => {
        if (!s.headersSent) s.writeHead(500)
        s.end(e.message)
      })
    })
  }

  async listen(port = 0): Promise<this> {
    await new Promise<void>((r) => this.#server.listen(port, '127.0.0.1', r))
    return this
  }

  close(): void {
    this.#server.closeAllConnections()
    this.#server.close()
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
  }
  get githubApi(): string {
    return `${this.origin}/api/v3`
  }
  get gitlabUrl(): string {
    return `${this.origin}/gitlab`
  }
  gitUrl(project: string): string {
    return `${this.origin}/git/${project}.git`
  }
  dir(project: string): string {
    return join(this.root, `${project}.git`)
  }

  /** Makes a repository whose main branch holds the files of `from`. */
  create(project: string, from: string): void {
    const dir = this.dir(project)
    mkdirSync(dir, { recursive: true })
    const env = {
      PATH: process.env.PATH,
      HOME: '/nonexistent',
      GIT_AUTHOR_NAME: 'repo',
      GIT_AUTHOR_EMAIL: 'repo@localhost',
      GIT_COMMITTER_NAME: 'repo',
      GIT_COMMITTER_EMAIL: 'repo@localhost',
    }
    const git = (...a: string[]): string => execFileSync('git', a, { env, encoding: 'utf8' }).trim()
    git('init', '-q', '--bare', '-b', 'main', '--template=', dir)
    git('-C', dir, 'config', 'http.receivepack', 'true')
    git('-C', dir, '--work-tree', from, 'add', '-A', '-f', '.')
    git('-C', dir, '--work-tree', from, 'commit', '-q', '-m', 'Initial commit')
  }

  branches(project: string): string[] {
    const out = execFileSync(
      'git',
      ['-C', this.dir(project), 'for-each-ref', '--format=%(refname:short)', 'refs/heads'],
      {
        encoding: 'utf8',
      },
    )
    return out.split('\n').filter(Boolean)
  }

  sha(project: string, branch: string): string | null {
    try {
      const args = ['-C', this.dir(project), 'rev-parse', '-q', '--verify', `refs/heads/${branch}`]
      return execFileSync('git', args, { encoding: 'utf8' }).trim()
    } catch {
      return null
    }
  }

  settle(project: string, number: number, state: 'merged' | 'closed'): void {
    const p = this.pulls.find((x) => x.project === project && x.number === number)
    if (p) p.state = state
  }

  /** A webhook as the host would send it. */
  hook(kind: 'github' | 'gitlab', p: FakePull, delivery: string = randomUUID()) {
    const body =
      kind === 'github'
        ? JSON.stringify({
            action: p.state,
            pull_request: { number: p.number },
            repository: { full_name: p.project },
          })
        : JSON.stringify({
            object_attributes: { iid: p.number },
            project: { path_with_namespace: p.project },
          })
    const headers: Record<string, string> =
      kind === 'github'
        ? {
            'x-github-event': 'pull_request',
            'x-github-delivery': delivery,
            'x-hub-signature-256': `sha256=${createHmac('sha256', this.hookSecret).update(body).digest('hex')}`,
          }
        : {
            'x-gitlab-event': 'Merge Request Hook',
            'x-gitlab-event-uuid': delivery,
            'x-gitlab-token': this.hookSecret,
          }
    return { headers, body }
  }

  #fault(method: string, ...among: Fault[]): Fault | null {
    const r = this.faults.find((f) => f.times > 0 && f.method === method && among.includes(f.fault))
    if (!r) return null
    r.times--
    return r.fault
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', this.origin)
    if (url.pathname.startsWith('/git/')) return this.#git(req, res, url)
    if (url.pathname.startsWith('/__/')) return this.#control(req, res, url)

    const body = await read(req)
    const bearer = req.headers.authorization?.replace(/^(token|bearer) /i, '') ?? req.headers['private-token']
    if (bearer !== this.token) {
      this.refused.push(`${req.method} ${url.pathname}`)
      res.writeHead(401).end('{"message":"Bad credentials"}')
      return
    }
    const method = req.method ?? 'GET'
    const json = (status: number, v: unknown, h: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json', ...h }).end(JSON.stringify(v))
    }
    const early = this.#fault(method, 'error-500', 'rate-limit', 'rate-reset')
    if (early === 'error-500') return json(500, { message: 'oops' })
    if (early === 'rate-limit') return json(429, { message: 'slow down' }, { 'retry-after': '1' })
    if (early === 'rate-reset') {
      const reset = String(Math.ceil(Date.now() / 1000) + 1)
      return json(
        403,
        { message: 'API rate limit exceeded' },
        { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset },
      )
    }
    const [status, v] = url.pathname.startsWith('/gitlab/')
      ? this.#gitlab(method, url, body)
      : this.#github(method, url, body)
    const late = this.#fault(method, 'lost-answer', 'done-but-502')
    if (late === 'lost-answer') {
      req.socket.destroy()
      return
    }
    if (late === 'done-but-502') return json(502, { message: 'bad gateway' })
    json(status, v)
  }

  #listed(project: string, head: string | null): FakePull[] {
    const all = this.pulls
      .filter((p) => p.project === project && (head === null || p.head === head))
      .reverse()
    if (this.#stale > 0) {
      this.#stale--
      return all.filter((p) => Date.now() - p.createdAt > 60_000)
    }
    return all
  }

  #open(
    project: string,
    head: string,
    base: string,
    title: string,
    body: string,
  ): FakePull | 'exists' | 'no branch' {
    if (this.sha(project, head) === null) return 'no branch'
    if (this.pulls.some((p) => p.project === project && p.head === head && p.state === 'open'))
      return 'exists'
    const number = this.pulls.filter((p) => p.project === project).length + 1
    const p: FakePull = { number, project, head, base, title, body, state: 'open', createdAt: Date.now() }
    this.pulls.push(p)
    if (this.#fault('POST', 'stale-list')) this.#stale = 2
    return p
  }

  #github(method: string, url: URL, body: Buffer): [number, unknown] {
    const view = (p: FakePull) => ({
      number: p.number,
      html_url: `${this.origin}/${p.project}/pull/${p.number}`,
      state: p.state === 'open' ? 'open' : 'closed',
      merged_at: p.state === 'merged' ? '2000-01-01T00:00:00Z' : null,
      head: { ref: p.head },
      title: p.title,
    })
    const m = /^\/api\/v3\/repos\/([^/]+\/[^/]+)\/(pulls|branches)(?:\/(.+))?$/.exec(url.pathname)
    if (!m) return [404, { message: 'Not Found' }]
    const project = m[1]!
    if (m[2] === 'branches') {
      const sha = this.sha(project, decodeURIComponent(m[3] ?? ''))
      return sha ? [200, { name: m[3], commit: { sha } }] : [404, { message: 'Branch not found' }]
    }
    if (method === 'POST') {
      const b = JSON.parse(body.toString()) as Record<string, string>
      const r = this.#open(project, b.head!, b.base!, b.title!, b.body ?? '')
      if (r === 'exists')
        return [422, { message: `Validation Failed: A pull request already exists for ${b.head}.` }]
      if (r === 'no branch') return [422, { message: 'Validation Failed: head invalid' }]
      return [201, view(r)]
    }
    if (m[3]) {
      const p = this.pulls.find((x) => x.project === project && x.number === Number(m[3]))
      return p ? [200, view(p)] : [404, { message: 'Not Found' }]
    }
    const head = url.searchParams.get('head')
    return [200, this.#listed(project, head ? head.slice(head.indexOf(':') + 1) : null).map(view)]
  }

  #gitlab(method: string, url: URL, body: Buffer): [number, unknown] {
    const view = (p: FakePull) => ({
      iid: p.number,
      web_url: `${this.origin}/${p.project}/-/merge_requests/${p.number}`,
      state: p.state === 'open' ? 'opened' : p.state,
      source_branch: p.head,
      title: p.title,
    })
    const m = /^\/gitlab\/api\/v4\/projects\/([^/]+)\/(merge_requests|repository\/branches)(?:\/(.+))?$/.exec(
      url.pathname,
    )
    if (!m) return [404, { message: '404 Not Found' }]
    const project = decodeURIComponent(m[1]!)
    if (m[2] !== 'merge_requests') {
      const sha = this.sha(project, decodeURIComponent(m[3] ?? ''))
      return sha ? [200, { name: m[3], commit: { id: sha } }] : [404, { message: '404 Branch Not Found' }]
    }
    if (method === 'POST') {
      const b = JSON.parse(body.toString()) as Record<string, string>
      const r = this.#open(project, b.source_branch!, b.target_branch!, b.title!, b.description ?? '')
      if (r === 'exists')
        return [409, { message: ['Another open merge request already exists for this source branch'] }]
      if (r === 'no branch') return [400, { message: 'source branch does not exist' }]
      return [201, view(r)]
    }
    if (m[3]) {
      const p = this.pulls.find((x) => x.project === project && x.number === Number(m[3]))
      return p ? [200, view(p)] : [404, { message: '404 Not found' }]
    }
    return [200, this.#listed(project, url.searchParams.get('source_branch')).map(view)]
  }

  /** For tests that run the host as its own process. */
  async #control(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await read(req)
    const json = (v: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v))
    }
    switch (url.pathname) {
      case '/__/pulls':
        return json(this.pulls)
      case '/__/faults':
        this.faults.push(...(JSON.parse(body.toString()) as FaultRule[]))
        return json(this.faults)
      case '/__/settle': {
        const s = JSON.parse(body.toString()) as {
          project: string
          number: number
          state: 'merged' | 'closed'
        }
        this.settle(s.project, s.number, s.state)
        return json({})
      }
      case '/__/branches':
        return json(this.branches(url.searchParams.get('project') ?? ''))
    }
    res.writeHead(404).end()
  }

  async #git(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const basic = Buffer.from((req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString()
    if (basic.slice(basic.indexOf(':') + 1) !== this.token) {
      this.refused.push(`${req.method} ${url.pathname}`)
      res.writeHead(401, { 'www-authenticate': 'Basic' }).end()
      return
    }
    const p = spawn('/usr/lib/git-core/git-http-backend', [], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: this.root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname.slice('/git'.length),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: req.headers['content-encoding'] ?? '',
        HTTP_GIT_PROTOCOL: (req.headers['git-protocol'] as string) ?? '',
        REMOTE_USER: 'x',
        REMOTE_ADDR: '127.0.0.1',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'safe.directory',
        GIT_CONFIG_VALUE_0: '*',
      },
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    p.stdin.on('error', () => {})
    req.pipe(p.stdin)
    let head = Buffer.alloc(0)
    let open = false
    p.stdout.on('data', (d: Buffer) => {
      if (open) {
        res.write(d)
        return
      }
      head = Buffer.concat([head, d])
      const end = head.indexOf('\r\n\r\n')
      if (end < 0) return
      open = true
      let status = 200
      for (const line of head.subarray(0, end).toString().split('\r\n')) {
        const [k, v] = [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]
        if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10)
        else res.setHeader(k, v)
      }
      res.writeHead(status)
      res.write(head.subarray(end + 4))
    })
    await new Promise<void>((r) => p.on('close', () => r()))
    res.end()
  }
}
