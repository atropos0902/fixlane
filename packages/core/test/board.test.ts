import { expect, test } from 'vitest'
import { apply, type Board, emptyBoard, LogEntry, ToServer } from '../src/index.ts'

const ticket = { id: 'sec-1', repo: 'r', kind: 'code' as const, title: 'T', body: '' }
const repo = { name: 'r', host: 'github' as const, project: 'o/r', base: 'main', mode: 'branch' as const }
let n = 0
const at = (e: object): LogEntry => LogEntry.parse({ seq: ++n, actor: 'sam', clientId: `client-${n}`, ...e })
const fold = (es: LogEntry[], b: Board = emptyBoard()): Board => es.reduce(apply, b)
const file = (): LogEntry => at({ type: 'ticket.filed', ticket: 'sec-1', data: ticket })
const taken = (epoch: number, holder = 'sam'): LogEntry =>
  at({ type: 'lease.taken', ticket: 'sec-1', data: { holder, session: `s${epoch}`, epoch } })
const moved = (epoch: number, state: string, note?: string): LogEntry =>
  at({ type: 'session.moved', ticket: 'sec-1', data: { session: `s${epoch}`, epoch, state, note } })
const card = (b: Board) => b.cards.get('sec-1')!

test('a ticket from filed to merged', () => {
  const pull = { number: 1, url: 'u', head: 'fix/sec-1/1', state: 'open' as const }
  const b = fold([
    at({ type: 'repo.added', ticket: null, data: repo }),
    at({ type: 'repo.mode', ticket: null, data: { repo: 'r', mode: 'pr' } }),
    file(),
    at({ type: 'ticket.commented', ticket: 'sec-1', data: { text: 'hi' } }),
    taken(1),
    moved(1, 'running', 'attempt 1'),
    at({ type: 'pull.opened', ticket: 'sec-1', data: { ...pull, epoch: 1 } }),
    at({ type: 'pull.changed', ticket: 'sec-1', data: { ...pull, state: 'merged' } }),
    moved(1, 'done'),
  ])
  expect(b.repos.get('r')!.mode).toBe('pr')
  expect(card(b)).toEqual({
    ticket,
    epoch: 1,
    holder: null,
    session: 's1',
    state: 'done',
    note: null,
    pull: { ...pull, state: 'merged' },
    comments: [{ actor: 'sam', text: 'hi' }],
  })
})

test('the old epoch is not heard any more', () => {
  const b = fold([file(), taken(1), moved(1, 'running'), taken(2, 'kim'), moved(1, 'checking')])
  expect(card(b)).toMatchObject({ epoch: 2, holder: 'kim', state: 'queued' })
  expect(card(fold([at({ type: 'lease.released', ticket: 'sec-1', data: { epoch: 1 } })], b)).holder).toBe(
    'kim',
  )
  expect(
    card(fold([at({ type: 'lease.released', ticket: 'sec-1', data: { epoch: 2 } })], b)).holder,
  ).toBeNull()
})

test('seeing an entry twice changes nothing', () => {
  const es = [file(), at({ type: 'ticket.commented', ticket: 'sec-1', data: { text: 'x' } })]
  expect(fold([...es, ...es])).toEqual(fold(es))
})

test('entries about things it does not know move seq and nothing else', () => {
  const es = [taken(1), at({ type: 'repo.mode', ticket: null, data: { repo: 'zz', mode: 'pr' } })]
  const b = fold(es)
  expect(b.seq).toBe(es[1]!.seq)
  expect(b.cards.size + b.repos.size).toBe(0)
})

test('filing the same id again does not wipe the card', () => {
  const b = fold([file(), taken(1), file()])
  expect(card(b).epoch).toBe(1)
})

test('a client cannot write what only the server may', () => {
  const draft = {
    type: 'lease.taken',
    ticket: 'sec-1',
    clientId: 'abcdefgh',
    data: { holder: 'x', session: 's', epoch: 9 },
  }
  expect(ToServer.safeParse({ t: 'append', draft }).success).toBe(false)
  const ok = { type: 'ticket.commented', ticket: 'sec-1', clientId: 'abcdefgh', data: { text: 'x' } }
  expect(ToServer.safeParse({ t: 'append', draft: ok }).success).toBe(true)
})
