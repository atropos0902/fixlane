import { readFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Repo, RepoMode, Ticket } from '@fixlane/core'
import { app, BrowserWindow, ipcMain, net, protocol, shell, type WebContents } from 'electron'
import { WebSocket } from 'ws'
import { z } from 'zod'
import type { Pushed } from './bridge.ts'

const SOCKET = process.env.FIXLANE_SOCKET ?? join(homedir(), '.local/state/fixlane/sock')
const UI = join(__dirname, '../ui')
let win: BrowserWindow | null = null

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true } }])

function daemon<T>(method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const q = request(
      { socketPath: SOCKET, method, path, headers: { 'content-type': 'application/json' } },
      (r) => {
        let text = ''
        r.on('data', (d) => {
          text += d
        })
        r.on('end', () => {
          const v = JSON.parse(text || '{}') as T & { error?: string }
          if ((r.statusCode ?? 500) >= 400) reject(new Error(v.error ?? `daemon: ${r.statusCode}`))
          else resolve(v)
        })
      },
    )
    q.on('error', () => reject(new Error('the daemon is not running')))
    q.end(body === undefined ? undefined : JSON.stringify(body))
  })
}

const push = (m: Pushed): void => win?.webContents.send('push', m)

function stream(): void {
  const ws = new WebSocket(`ws+unix:${SOCKET}:/v1/stream`)
  ws.on('open', () => push({ t: 'daemon', up: true }))
  ws.on('message', (raw) => push(JSON.parse(String(raw)) as Pushed))
  ws.on('error', () => {})
  ws.on('close', () => {
    push({ t: 'daemon', up: false })
    setTimeout(stream, 1000)
  })
}

const Id = z.string().regex(/^[0-9a-f]{4,32}$/)
const TicketId = Ticket.shape.id
const RuntimeName = z.enum(['claude', 'codex', 'replay'])

/** Only our own page may ask, and only with arguments of the right shape. */
function handle<A extends z.ZodTuple>(
  name: string,
  args: A,
  fn: (...a: z.infer<A>) => Promise<unknown>,
): void {
  ipcMain.handle(name, (e, ...raw) => {
    if (e.senderFrame?.parent || !e.senderFrame?.url.startsWith('app://ui/')) throw new Error('not from here')
    return fn(...args.parse(raw))
  })
}

handle('state', z.tuple([]), () => daemon('GET', '/v1/state'))
handle('session', z.tuple([Id]), (id) => daemon('GET', `/v1/sessions/${id}`))
handle('start', z.tuple([TicketId, RuntimeName, z.boolean()]), (id, runtime, moveHere) =>
  daemon('POST', `/v1/tickets/${id}/start`, { runtime, moveHere }),
)
handle('cancel', z.tuple([Id]), (id) => daemon('POST', `/v1/sessions/${id}/cancel`, {}))
handle('file', z.tuple([Ticket]), (t) => daemon('POST', '/v1/tickets', t))
handle('comment', z.tuple([TicketId, z.string().min(1).max(4000)]), (id, text) =>
  daemon('POST', `/v1/tickets/${id}/comment`, { text }),
)
handle('setMode', z.tuple([Repo.shape.name, RepoMode]), (repo, mode) =>
  daemon('POST', `/v1/repos/${repo}/mode`, { mode }),
)
handle('openPull', z.tuple([z.url({ protocol: /^https?$/ })]), (url) => shell.openExternal(url))

const terms = new Map<string, WebSocket>()
const key = (c: WebContents, line: number): string => `${c.id}:${line}`
const Line = z.number().int()

ipcMain.on('term-open', (e, rawLine, rawId) => {
  const line = Line.parse(rawLine)
  const id = Id.parse(rawId)
  const ws = new WebSocket(`ws+unix:${SOCKET}:/v1/sessions/${id}/terminal`)
  terms.set(key(e.sender, line), ws)
  ws.on('message', (d) => e.sender.isDestroyed() || e.sender.send('term-data', line, String(d)))
  ws.on('error', () => {})
  ws.on('close', (_, why) => {
    terms.delete(key(e.sender, line))
    if (!e.sender.isDestroyed()) e.sender.send('term-end', line, String(why))
  })
  e.sender.once('destroyed', () => ws.close())
})
const send = (c: WebContents, line: number, m: unknown): void => {
  const ws = terms.get(key(c, line))
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m))
  else ws?.once('open', () => ws.send(JSON.stringify(m)))
}
ipcMain.on('term-write', (e, line, d) => send(e.sender, Line.parse(line), { data: z.string().parse(d) }))
ipcMain.on('term-resize', (e, line, cols, rows) =>
  send(e.sender, Line.parse(line), { cols: Line.parse(cols), rows: Line.parse(rows) }),
)
ipcMain.on('term-close', (e, line) => terms.get(key(e.sender, Line.parse(line)))?.close())

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'"
const TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

async function serve(req: Request): Promise<Response> {
  const path = normalize(join(UI, decodeURIComponent(new URL(req.url).pathname)))
  if (!path.startsWith(UI + sep)) return new Response('no', { status: 404 })
  try {
    if (extname(path) === '.html') {
      return new Response(await readFile(path), {
        headers: { 'content-type': 'text/html', 'content-security-policy': CSP },
      })
    }
    const r = await net.fetch(pathToFileURL(path).toString())
    return new Response(r.body, {
      headers: { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' },
    })
  } catch {
    return new Response('not found', { status: 404 })
  }
}

function open(): void {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#f6f5f1',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  })
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_, __, done) => done(false))
  win.on('closed', () => {
    win = null
  })
  void win.loadURL('app://ui/index.html')
}

if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', () => win?.focus())
void app.whenReady().then(() => {
  protocol.handle('app', serve)
  open()
  stream()
  app.on('activate', () => win ?? open())
})
// The daemon is another process. Closing the window does not touch what it is doing.
app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
