import { useCallback, useEffect, useRef, useState } from 'react'
import type { Runtime, SessionView, TicketView } from '../electron/bridge.ts'
import { Live } from './Live.tsx'
import { Review } from './Review.tsx'
import { canStart, doing, working } from './words.ts'

interface Props {
  view: TicketView
  runtimes: Runtime[]
  shared: boolean
  act: (p: Promise<unknown>) => Promise<void>
}

const PATH = ['cloning', 'running', 'checking', 'proposing', 'in_review', 'done'] as const

export function SessionPage({ view: t, runtimes, shared, act }: Props) {
  const id = t.local?.id ?? null
  const [session, setSession] = useState<SessionView | null>(null)
  const [tab, setTab] = useState<'live' | 'review'>(t.state === 'in_review' ? 'review' : 'live')
  const [runtime, setRuntime] = useState<Runtime>(runtimes[0]!)
  const heading = useRef<HTMLHeadingElement>(null)
  const moved = `${t.local?.state} ${t.local?.attempt} ${t.local?.head} ${t.local?.paused}`

  useEffect(() => heading.current?.focus(), [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: a move is the reason to load again
  useEffect(() => {
    if (id) void window.fixlane.session(id).then(setSession, () => setSession(null))
  }, [id, moved])

  const start = useCallback(
    (moveHere: boolean) => void act(window.fixlane.start(t.ticket.id, runtime, moveHere)),
    [act, t.ticket.id, runtime],
  )
  const elsewhere = t.holder !== null && !t.mine && working(t.state)
  const at = PATH.indexOf(t.state as (typeof PATH)[number])
  const s = t.local

  return (
    <main className="ticket">
      <aside>
        <h1 ref={heading} tabIndex={-1}>
          {t.ticket.title}
        </h1>
        <p className="id">
          {t.ticket.id} in {t.ticket.repo}
        </p>
        {t.ticket.body && <p className="body">{t.ticket.body}</p>}
        {t.ticket.advisory && (
          <p className="body">
            {t.ticket.advisory.id}: {t.ticket.advisory.package} {t.ticket.advisory.affected}
          </p>
        )}
        <ol className="path" aria-label="Progress">
          {PATH.map((p, i) => (
            <li
              key={p}
              className={i < at ? 'past' : i === at ? 'now' : ''}
              aria-current={i === at ? 'step' : undefined}
            >
              {p.replace('_', ' ')}
            </li>
          ))}
        </ol>
        <p className={`status ${t.state}`} role="status">
          {t.mine && s?.paused ? 'Paused, somebody is in its shell' : doing[t.state]}
          {elsewhere && ` on the desktop of ${t.holder}`}
          {s && t.mine && s.attempt > 1 && `, attempt ${s.attempt}`}
        </p>
        {t.note && <p className="note">{t.note}</p>}
        <div className="actions">
          {canStart(t) && (
            <>
              <label>
                Agent
                <select value={runtime} onChange={(e) => setRuntime(e.target.value as Runtime)}>
                  {runtimes.map((r) => (
                    <option key={r} value={r}>
                      {r === 'replay' ? 'recorded session' : r}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" className="main" onClick={() => start(false)}>
                {t.state === 'stopped' ? 'Start again' : 'Start'}
              </button>
            </>
          )}
          {elsewhere && (
            <button type="button" className="main" onClick={() => start(true)}>
              Move it here
            </button>
          )}
          {t.mine && s && working(t.state) && (
            <button type="button" onClick={() => void act(window.fixlane.cancel(s.id))}>
              Cancel
            </button>
          )}
          {t.pull && (
            <button type="button" onClick={() => void act(window.fixlane.openPull(t.pull!.url))}>
              Open pull request {t.pull.number}
            </button>
          )}
        </div>
        {session?.reviewDir && (
          <p className="body">
            The branch is checked out in <code>{session.reviewDir}</code>
          </p>
        )}
        {s && s.tokensIn + s.tokensOut > 0 && (
          <p className="body">
            {(s.tokensIn + s.tokensOut).toLocaleString('en')} tokens
            {s.costMicros > 0 && `, $${(s.costMicros / 1e6).toFixed(2)}`}
          </p>
        )}
        {shared && <Comments view={t} act={act} />}
      </aside>
      <section className="work">
        {!s ? (
          <p className="empty">No session on this machine.</p>
        ) : (
          <>
            <div className="tabs" role="tablist">
              {(['live', 'review'] as const).map((x) => (
                <button
                  key={x}
                  type="button"
                  role="tab"
                  aria-selected={tab === x}
                  aria-controls={`tab-${x}`}
                  onClick={() => setTab(x)}
                >
                  {x === 'live' ? 'Session' : 'Review'}
                </button>
              ))}
            </div>
            <div id={`tab-${tab}`} role="tabpanel" className="panel">
              {tab === 'live' ? (
                <Live key={s.id} id={s.id} canTakeOver={t.mine && t.state === 'running'} />
              ) : (
                <Review session={session} />
              )}
            </div>
          </>
        )}
      </section>
    </main>
  )
}

function Comments({ view, act }: { view: TicketView; act: Props['act'] }) {
  const [text, setText] = useState('')
  const send = (): void => {
    if (text.trim() === '') return
    void act(window.fixlane.comment(view.ticket.id, text.trim()))
    setText('')
  }
  return (
    <div className="comments">
      <h2>Comments</h2>
      <ul>
        {view.comments.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: comments are only ever added at the end
          <li key={i}>
            <b>{c.actor}</b> {c.text}
          </li>
        ))}
      </ul>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          send()
        }}
      >
        <input aria-label="Comment" value={text} onChange={(e) => setText(e.target.value)} />
        <button type="submit">Send</button>
      </form>
    </div>
  )
}
