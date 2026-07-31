import { isOver } from './machine.ts'
import type { LogEntry, Pull, Repo, SessionState, Ticket } from './schema.ts'

export interface Card {
  ticket: Ticket
  epoch: number
  holder: string | null
  session: string | null
  state: SessionState | null
  note: string | null
  pull: Pull | null
  comments: { actor: string; text: string }[]
}

export interface Board {
  seq: number
  repos: Map<string, Repo>
  cards: Map<string, Card>
}

export const emptyBoard = (): Board => ({ seq: 0, repos: new Map(), cards: new Map() })

/** Every desktop folds the same log in the same order, so they end up with the same board. */
export function apply(b: Board, e: LogEntry): Board {
  if (e.seq <= b.seq) return b
  const card = e.ticket === null ? undefined : b.cards.get(e.ticket)
  const put = (id: string, c: Card): Board => ({ ...b, seq: e.seq, cards: new Map(b.cards).set(id, c) })
  const same: Board = { ...b, seq: e.seq }

  switch (e.type) {
    case 'repo.added':
      return { ...same, repos: new Map(b.repos).set(e.data.name, e.data) }
    case 'repo.mode': {
      const r = b.repos.get(e.data.repo)
      return r ? { ...same, repos: new Map(b.repos).set(r.name, { ...r, mode: e.data.mode }) } : same
    }
    case 'ticket.filed':
      if (card) return same
      return put(e.data.id, {
        ticket: e.data,
        epoch: 0,
        holder: null,
        session: null,
        state: null,
        note: null,
        pull: null,
        comments: [],
      })
  }
  if (!card) return same
  const id = card.ticket.id
  switch (e.type) {
    case 'ticket.commented':
      return put(id, { ...card, comments: [...card.comments, { actor: e.actor, text: e.data.text }] })
    case 'lease.taken':
      return put(id, {
        ...card,
        epoch: e.data.epoch,
        holder: e.data.holder,
        session: e.data.session,
        state: 'queued',
        note: null,
      })
    case 'lease.released':
      return e.data.epoch === card.epoch ? put(id, { ...card, holder: null }) : same
    case 'session.moved':
      if (e.data.epoch !== card.epoch) return same
      return put(id, {
        ...card,
        state: e.data.state,
        note: e.data.note ?? null,
        holder: isOver(e.data.state) ? null : card.holder,
      })
    case 'pull.opened':
    case 'pull.changed': {
      const { number, url, head, state } = e.data
      return put(id, { ...card, pull: { number, url, head, state } })
    }
  }
}
