import type { TicketView } from '../electron/bridge.ts'

export const COLUMNS: { name: string; states: TicketView['state'][] }[] = [
  { name: 'Open', states: ['open'] },
  { name: 'Working', states: ['queued', 'cloning', 'running', 'checking', 'proposing'] },
  { name: 'In review', states: ['in_review'] },
  { name: 'Done', states: ['done'] },
  { name: 'Stopped', states: ['stopped'] },
]

export const doing: Record<TicketView['state'], string> = {
  open: 'Nobody is on it',
  queued: 'Waiting for its turn',
  cloning: 'Making a clone',
  running: 'The agent is working',
  checking: 'Checking the branch',
  proposing: 'Pushing the branch',
  in_review: 'Waiting for a reviewer',
  done: 'Done',
  stopped: 'Stopped',
}

export const working = (s: TicketView['state']): boolean => COLUMNS[1]!.states.includes(s)
export const canStart = (t: TicketView): boolean => t.state === 'open' || t.state === 'stopped'
