import { useCallback, useEffect, useState } from 'react'
import type { StateView, TicketView } from '../electron/bridge.ts'
import { Board } from './Board.tsx'
import { Help } from './Help.tsx'
import { NewTicket } from './NewTicket.tsx'
import { Repos } from './Repos.tsx'
import { SessionPage } from './SessionPage.tsx'

export type Page = { at: 'board' } | { at: 'ticket'; id: string }
type Panel = 'help' | 'new' | 'repos' | null

const typing = (e: KeyboardEvent): boolean =>
  e.target instanceof HTMLElement &&
  (e.target.closest('input, textarea, select, .terminal') !== null || e.target.isContentEditable)

export function App() {
  const [state, setState] = useState<StateView | null>(null)
  const [down, setDown] = useState(false)
  const [page, setPage] = useState<Page>({ at: 'board' })
  const [panel, setPanel] = useState<Panel>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      setState(await window.fixlane.state())
      setDown(false)
    } catch {
      setDown(true)
    }
  }, [])

  useEffect(() => {
    void load()
    let due: ReturnType<typeof setTimeout> | undefined
    const off = window.fixlane.onPush((m) => {
      if (m.t === 'line') return
      if (m.t === 'daemon' && !m.up) setDown(true)
      clearTimeout(due)
      due = setTimeout(() => void load(), 40)
    })
    return () => {
      clearTimeout(due)
      off()
    }
  }, [load])

  /** Runs something the daemon may refuse, and shows what it said. */
  const act = useCallback(async (p: Promise<unknown>) => {
    setProblem(null)
    try {
      await p
    } catch (e) {
      setProblem((e as Error).message.replace(/^Error invoking remote method '\w+': (Error: )?/, ''))
    }
  }, [])

  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest?.('.terminal')) {
        if (panel) setPanel(null)
        else setPage({ at: 'board' })
        return
      }
      if (typing(e) || e.ctrlKey || e.metaKey || e.altKey || panel) return
      if (e.key === '?') setPanel('help')
      else if (e.key === 'n') setPanel('new')
      else if (e.key === 'r') setPanel('repos')
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [panel])

  const current = page.at === 'ticket' ? state?.tickets.find((t) => t.ticket.id === page.id) : undefined
  return (
    <>
      <header>
        <button type="button" className="home" onClick={() => setPage({ at: 'board' })}>
          fixlane
        </button>
        <Where state={state} down={down} ticket={current} />
        <nav>
          <button type="button" onClick={() => setPanel('new')}>
            New ticket <kbd>n</kbd>
          </button>
          <button type="button" onClick={() => setPanel('repos')}>
            Repositories <kbd>r</kbd>
          </button>
          <button type="button" onClick={() => setPanel('help')} aria-label="Keyboard help">
            <kbd>?</kbd>
          </button>
        </nav>
      </header>
      {problem && (
        <div className="problem" role="alert">
          {problem}
          <button type="button" onClick={() => setProblem(null)}>
            Dismiss
          </button>
        </div>
      )}
      {!state ? (
        <main className="empty">
          {down
            ? 'The daemon is not running. Start it with “pnpm daemon” and this window will notice.'
            : 'Loading'}
        </main>
      ) : current ? (
        <SessionPage
          key={current.ticket.id}
          view={current}
          runtimes={state.runtimes}
          shared={state.online !== null}
          act={act}
        />
      ) : (
        <Board state={state} open={(id) => setPage({ at: 'ticket', id })} act={act} />
      )}
      {panel === 'help' && <Help close={() => setPanel(null)} />}
      {panel === 'new' && state && <NewTicket repos={state.repos} act={act} close={() => setPanel(null)} />}
      {panel === 'repos' && state && <Repos repos={state.repos} act={act} close={() => setPanel(null)} />}
    </>
  )
}

function Where({
  state,
  down,
  ticket,
}: {
  state: StateView | null
  down: boolean
  ticket: TicketView | undefined
}) {
  const link = down
    ? 'daemon stopped'
    : state?.online === false
      ? 'offline, changes are kept'
      : state?.online
        ? 'shared'
        : null
  return (
    <p className="where" aria-live="polite">
      {ticket && <span>{ticket.ticket.repo}</span>}
      {link && <span className={down || state?.online === false ? 'warn' : ''}>{link}</span>}
    </p>
  )
}
