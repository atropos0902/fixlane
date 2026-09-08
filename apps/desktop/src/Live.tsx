import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import type { TerminalLine } from '../electron/bridge.ts'

/** The agent's text is not ours. Nothing in it may steer the terminal. */
const ESC = '\u001b'
const SEQUENCES = new RegExp(`${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^\u0007${ESC}]*(?:\u0007|${ESC}\\\\)|.)`, 'g')
const CONTROLS = /\p{Cc}/gu
const tame = (s: string): string =>
  s.replace(SEQUENCES, '').replace(CONTROLS, (c) => (c === '\n' || c === '\t' ? c : ''))

const lines = (s: string): string => tame(s.replace(/\r\n/g, '\n')).replace(/\n/g, '\r\n')
const dim = (s: string): string => `\x1b[90m${s}\x1b[0m`

export function show(line: unknown): string {
  const l = line as {
    t: string
    text?: string
    name?: string
    input?: string
    reason?: string
    ok?: boolean
    error?: string
  }
  switch (l.t) {
    case 'text':
      return `${lines(l.text ?? '')}\r\n`
    case 'tool':
      return `\x1b[36m${tame(l.name ?? '')}\x1b[0m ${lines(l.input ?? '')}\r\n`
    case 'output':
      return l.text ? `${dim(lines(l.text.trimEnd()))}\r\n` : ''
    case 'stop':
      return `\x1b[33mstopped\x1b[0m ${lines(l.reason ?? '')}\r\n`
    default:
      return l.ok ? dim('the agent is finished\r\n') : `\x1b[31m${lines(l.error ?? 'failed')}\x1b[0m\r\n`
  }
}

const colours = (): { background: string; foreground: string; cursor: string } => {
  const s = getComputedStyle(document.documentElement)
  const at = (n: string): string => s.getPropertyValue(n).trim()
  return { background: at('--well'), foreground: at('--ink'), cursor: at('--accent') }
}

export function Live({ id, canTakeOver }: { id: string; canTakeOver: boolean }) {
  const box = useRef<HTMLDivElement>(null)
  const [mine, setMine] = useState(false)
  const [ended, setEnded] = useState<string | null>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const term = new Terminal({
      convertEol: false,
      disableStdin: !mine,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      theme: colours(),
      scrollback: 10_000,
      screenReaderMode: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(box.current!)
    fit.fit()
    const sized = new ResizeObserver(() => fit.fit())
    sized.observe(box.current!)
    const off: (() => void)[] = [() => sized.disconnect()]

    if (mine) {
      const line: TerminalLine = window.fixlane.takeOver(
        id,
        (d) => term.write(d),
        (why) => {
          setEnded(why || null)
          setMine(false)
        },
      )
      term.onData((d) => line.write(d))
      term.onResize(({ cols, rows }) => line.resize(cols, rows))
      line.resize(term.cols, term.rows)
      // Tab and Escape belong to the shell, so F6 is the way out for the keyboard.
      term.attachCustomKeyEventHandler((e) => {
        if (e.key !== 'F6') return true
        if (e.type === 'keydown') button.current?.focus()
        return false
      })
      term.focus()
      off.push(() => line.hangUp())
    } else {
      const seen = new Set<string>()
      const add = (l: { attempt: number; n: number; line: unknown }): void => {
        const k = `${l.attempt}:${l.n}`
        if (seen.has(k)) return
        if (l.n === 0) term.write(dim(`attempt ${l.attempt}\r\n`))
        seen.add(k)
        term.write(show(l.line))
      }
      const held: Parameters<typeof add>[0][] = []
      let ready = false
      off.push(
        window.fixlane.onPush((m) => {
          if (m.t !== 'line' || m.session !== id) return
          if (ready) add(m)
          else held.push(m)
        }),
      )
      void window.fixlane.session(id).then((v) => {
        for (const l of v.lines) add(l)
        for (const l of held) add(l)
        ready = true
      })
    }
    const dark = matchMedia('(prefers-color-scheme: dark)')
    const recolour = (): void => {
      term.options.theme = colours()
    }
    dark.addEventListener('change', recolour)
    off.push(() => dark.removeEventListener('change', recolour))
    return () => {
      for (const f of off) f()
      term.dispose()
    }
  }, [id, mine])

  return (
    <div className="live">
      <div className="bar">
        {mine ? (
          <>
            <span>The agent is paused. This is a shell in its container.</span>
            <button ref={button} type="button" className="main" onClick={() => setMine(false)}>
              Hand back <kbd>F6</kbd>
            </button>
          </>
        ) : (
          <>
            <span>{ended ?? ''}</span>
            {canTakeOver && (
              <button type="button" onClick={() => setMine(true)}>
                Take over
              </button>
            )}
          </>
        )}
      </div>
      <section
        ref={box}
        className="term"
        aria-label={mine ? 'Shell in the container' : 'What the agent did'}
      />
    </div>
  )
}
