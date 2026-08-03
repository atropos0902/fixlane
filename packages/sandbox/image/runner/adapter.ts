export interface Spec {
  runtime: 'claude' | 'codex' | 'replay'
  prompt: string
  model?: string
}

export type Line =
  | { t: 'text'; text: string }
  | { t: 'tool'; name: string; input: string }
  | { t: 'output'; text: string }
  | { t: 'stop'; reason: string }
  | { t: 'end'; ok: boolean; error?: string }

export type Emit = (l: Line) => void

/** Runs one agent to the end. Throwing means it did not get there. */
export interface Adapter {
  run(spec: Spec, emit: Emit, over: AbortSignal): Promise<void>
}

export const MODEL_PORT = 4801
export const PACKAGE_PORT = 4802
export const MCP = { command: 'node', args: ['/opt/runner/mcp.ts'] }
export const clip = (v: unknown): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s && s.length > 4000 ? `${s.slice(0, 4000)} (cut)` : (s ?? '')
}
