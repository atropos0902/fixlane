import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import type { StateView, TicketView } from '../electron/bridge.ts'
import { COLUMNS, canStart, doing } from './words.ts'

interface Props {
  state: StateView
  open: (id: string) => void
  act: (p: Promise<unknown>) => Promise<void>
}

let remembered: string | null = null

export function Board({ state, open, act }: Props) {
  const columns = COLUMNS.map((c) => ({
    ...c,
    cards: state.tickets.filter((t) => c.states.includes(t.state)),
  }))
  const [focus, setFocus] = useState<string | null>(remembered)
  const grid = useRef<HTMLDivElement>(null)
  const ids = state.tickets.map((t) => t.ticket.id)
  const stop =
    focus && ids.includes(focus)
      ? focus
      : (columns.find((c) => c.cards.length > 0)?.cards[0]?.ticket.id ?? null)

  useEffect(() => {
    if (remembered) grid.current?.querySelector<HTMLElement>(`[data-id="${remembered}"]`)?.focus()
  }, [])

  const go = (id: string | undefined): void => {
    if (!id) return
    remembered = id
    setFocus(id)
    grid.current?.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus()
  }

  const onKey = (e: KeyboardEvent, t: TicketView): void => {
    const c = columns.findIndex((x) => x.cards.includes(t))
    const i = columns[c]!.cards.indexOf(t)
    const across = (step: number): void => {
      for (let n = c + step; n >= 0 && n < columns.length; n += step) {
        const cards = columns[n]!.cards
        if (cards.length > 0) return go(cards[Math.min(i, cards.length - 1)]!.ticket.id)
      }
    }
    if (e.key === 'ArrowDown') go(columns[c]!.cards[i + 1]?.ticket.id)
    else if (e.key === 'ArrowUp') go(columns[c]!.cards[i - 1]?.ticket.id)
    else if (e.key === 'ArrowRight') across(1)
    else if (e.key === 'ArrowLeft') across(-1)
    else if (e.key === 's' && canStart(t))
      void act(window.fixlane.start(t.ticket.id, state.runtimes[0]!, false))
    else return
    e.preventDefault()
  }

  if (state.tickets.length === 0) {
    return <main className="empty">No tickets yet. Press n to file the first one.</main>
  }
  return (
    <main className="board" ref={grid}>
      {columns.map((c) => (
        <section key={c.name} aria-label={c.name}>
          <h2>
            {c.name} <span>{c.cards.length}</span>
          </h2>
          <ul>
            {c.cards.map((t) => (
              <li key={t.ticket.id}>
                <button
                  type="button"
                  className={`card ${t.state}`}
                  data-id={t.ticket.id}
                  tabIndex={t.ticket.id === stop ? 0 : -1}
                  onFocus={() => {
                    remembered = t.ticket.id
                    setFocus(t.ticket.id)
                  }}
                  onKeyDown={(e) => onKey(e, t)}
                  onClick={() => open(t.ticket.id)}
                >
                  <span className="id">{t.ticket.id}</span>
                  <span className="title">{t.ticket.title}</span>
                  <span className="foot">
                    {t.ticket.repo}
                    {t.holder && !t.mine && `, with ${t.holder}`}
                    {c.name === 'Working' && `. ${doing[t.state]}`}
                    {t.local?.paused && t.mine && ', taken over'}
                  </span>
                  {t.note && <span className="note">{t.note}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  )
}
