import type { Repo, Ticket } from '@fixlane/core'
import type { SessionView, StateView } from '@fixlane/daemon/api'

export type { SessionView, StateView, TicketView } from '@fixlane/daemon/api'
export type Runtime = StateView['runtimes'][number]

export interface TerminalLine {
  write(data: string): void
  resize(cols: number, rows: number): void
  hangUp(): void
}

export type Pushed =
  | { t: 'board' }
  | { t: 'session'; session: { id: string; ticket: string } }
  | { t: 'line'; session: string; attempt: number; n: number; line: unknown }
  | { t: 'daemon'; up: boolean }

/** Everything the window can ask for. There is no general "call the daemon". */
export interface Bridge {
  state(): Promise<StateView>
  session(id: string): Promise<SessionView>
  start(ticket: string, runtime: Runtime, moveHere: boolean): Promise<void>
  cancel(session: string): Promise<void>
  file(ticket: Ticket): Promise<void>
  comment(ticket: string, text: string): Promise<void>
  setMode(repo: string, mode: Repo['mode']): Promise<void>
  openPull(url: string): Promise<void>
  onPush(fn: (m: Pushed) => void): () => void
  takeOver(session: string, onData: (d: string) => void, onEnd: (why: string) => void): TerminalLine
}

declare global {
  interface Window {
    fixlane: Bridge
  }
}
