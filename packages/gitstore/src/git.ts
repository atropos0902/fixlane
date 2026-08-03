import { spawn } from 'node:child_process'

export class GitError extends Error {
  readonly exit: number | null
  readonly stderr: string
  constructor(args: readonly string[], exit: number | null, stderr: string) {
    super(`git ${args[0]} failed (${exit}): ${stderr.trim().slice(0, 600)}`)
    this.exit = exit
    this.stderr = stderr
  }
}

export interface GitOptions {
  cwd?: string
  config?: Record<string, string>
  env?: Record<string, string>
  timeoutMs?: number
  input?: Buffer
}

// Nothing from the user's or the machine's git setup applies here, and no hook ever runs.
const FIXED: Record<string, string> = {
  'core.hooksPath': '/dev/null',
  'gc.auto': '0',
  'maintenance.auto': 'false',
  'fetch.fsckObjects': 'true',
  'protocol.ext.allow': 'never',
  'safe.directory': '*',
  'credential.helper': '',
}

/** Config goes through the environment so that a token never shows up in a process list. */
function environment(o: GitOptions): NodeJS.ProcessEnv {
  const entries = Object.entries({ ...FIXED, ...o.config })
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: '/nonexistent',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(entries.length),
    ...o.env,
  }
  entries.forEach(([k, v], i) => {
    env[`GIT_CONFIG_KEY_${i}`] = k
    env[`GIT_CONFIG_VALUE_${i}`] = v
  })
  return env
}

export function gitRaw(args: readonly string[], o: GitOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { cwd: o.cwd, env: environment(o), stdio: ['pipe', 'pipe', 'pipe'] })
    p.stdin.on('error', () => {}) // git may exit before it has read everything
    p.stdin.end(o.input)
    const out: Buffer[] = []
    let err = ''
    const timer = setTimeout(() => p.kill('SIGKILL'), o.timeoutMs ?? 120_000)
    p.stdout.on('data', (d: Buffer) => out.push(d))
    p.stderr.on('data', (d: Buffer) => {
      if (err.length < 20_000) err += d.toString()
    })
    p.on('error', reject)
    p.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(Buffer.concat(out))
      else reject(new GitError(args, code, err))
    })
  })
}

export async function git(args: readonly string[], o: GitOptions = {}): Promise<string> {
  return (await gitRaw(args, o)).toString('utf8').trimEnd()
}
