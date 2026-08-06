import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'

/** package -> version -> file -> contents */
export type Packages = Record<string, Record<string, Record<string, string>>>

function tar(files: Record<string, string>): Buffer {
  const out: Buffer[] = []
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text)
    const h = Buffer.alloc(512)
    h.write(`package/${name}`, 0)
    h.write('0000644\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124)
    h.write('00000000000\0', 136)
    h.write('        ', 148)
    h.write('0', 156)
    h.write('ustar\x0000', 257)
    let sum = 0
    for (const b of h) sum += b
    h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
    out.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  out.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(out), { level: 9 })
}

export class FakeRegistry {
  readonly requests: string[] = []
  readonly #tgz = new Map<string, { bytes: Buffer; integrity: string }>()
  readonly #pkgs: Packages
  readonly #server: Server

  constructor(pkgs: Packages) {
    this.#pkgs = pkgs
    for (const [name, versions] of Object.entries(pkgs)) {
      for (const [version, files] of Object.entries(versions)) {
        const bytes = tar({
          'package.json': JSON.stringify({ name, version, main: 'index.js', type: 'commonjs' }),
          ...files,
        })
        const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
        this.#tgz.set(`${name}@${version}`, { bytes, integrity })
      }
    }
    this.#server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      this.requests.push(`${req.method} ${path}`)
      const t = /^\/((?:@[^/]+\/)?[^/]+)\/-\/[^/]+?-(\d+\.\d+\.\d+)\.tgz$/.exec(path)
      const tgz = t ? this.#tgz.get(`${t[1]}@${t[2]}`) : undefined
      if (tgz) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(tgz.bytes)
        return
      }
      const name = path.slice(1)
      if (!this.#pkgs[name]) {
        res.writeHead(404).end('{"error":"not found"}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(this.packument(name)))
    })
  }

  packument(name: string) {
    const versions = Object.entries(this.#pkgs[name]!)
    const entry = ([version, files]: [string, Record<string, string>]) => {
      const extra = files['package.json'] ? (JSON.parse(files['package.json']) as object) : {}
      const dist = {
        tarball: `${this.origin}/${name}/-/${name.replace(/^@[^/]+\//, '')}-${version}.tgz`,
        integrity: this.#tgz.get(`${name}@${version}`)!.integrity,
      }
      return [version, { name, version, ...extra, dist }] as const
    }
    const latest = versions.at(-1)![0]
    return { name, 'dist-tags': { latest }, versions: Object.fromEntries(versions.map(entry)) }
  }

  integrity(name: string, version: string): string | null {
    return this.#tgz.get(`${name}@${version}`)?.integrity ?? null
  }

  async listen(port = 0): Promise<this> {
    await new Promise<void>((r) => this.#server.listen(port, '127.0.0.1', r))
    return this
  }
  get origin(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
  }
  close(): void {
    this.#server.closeAllConnections()
    this.#server.close()
  }
}
