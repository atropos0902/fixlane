import type { SessionView } from '../electron/bridge.ts'

interface FileDiff {
  path: string
  lines: { kind: 'add' | 'del' | 'same' | 'hunk'; text: string }[]
}

export function parse(diff: string): FileDiff[] {
  const out: FileDiff[] = []
  for (const l of diff.split('\n')) {
    const file = /^diff --git a\/.+ b\/(.+)$/.exec(l)
    if (file) out.push({ path: file[1]!, lines: [] })
    const now = out.at(-1)
    if (!now || file || /^(index |--- |\+\+\+ |new file|deleted file|old mode|new mode|similarity)/.test(l))
      continue
    if (l.startsWith('@@')) now.lines.push({ kind: 'hunk', text: l.replace(/^(@@ .+? @@).*/, '$1') })
    else if (l.startsWith('+')) now.lines.push({ kind: 'add', text: l.slice(1) })
    else if (l.startsWith('-')) now.lines.push({ kind: 'del', text: l.slice(1) })
    else if (l.startsWith(' ')) now.lines.push({ kind: 'same', text: l.slice(1) })
  }
  return out
}

const SIGN = { add: '+', del: '−', same: ' ', hunk: '' }

export function Review({ session }: { session: SessionView | null }) {
  if (!session?.verdict && !session?.diff) return <p className="empty">Nothing to review yet.</p>
  const v = session.verdict
  return (
    <div className="review">
      <section className="diff" aria-label="Changes" tabIndex={0}>
        {session.diff ? (
          parse(session.diff).map((f) => (
            <article key={f.path}>
              <h3>{f.path}</h3>
              <pre>
                {f.lines.map((l, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: a diff does not change
                  <span key={i} className={l.kind}>
                    <i aria-hidden="true">{SIGN[l.kind]}</i>
                    {l.text}
                    {'\n'}
                  </span>
                ))}
              </pre>
            </article>
          ))
        ) : (
          <p className="empty">There is no branch.</p>
        )}
      </section>
      <section className="runs" aria-label="Test runs" tabIndex={0}>
        {v && (
          <p className={v.ok ? 'good' : 'bad'}>{v.ok ? 'The checks passed.' : `Turned down: ${v.why}`}</p>
        )}
        {v && <Runs v={v} />}
      </section>
    </div>
  )
}

/** Base on the left and branch on the right, so that a proof reads as a red and a green on one line. */
function Runs({ v }: { v: NonNullable<SessionView['verdict']> }) {
  const pairs: [string, string, string][] = [
    ['New tests', 'New tests on base', 'New tests on the branch'],
    ['Tests as they were', 'Suite on base', 'Same suite on the branch'],
  ]
  return pairs.map(([title, a, b]) => {
    const left = v.runs.find((r) => r.label === a)
    const right = v.runs.find((r) => r.label === b)
    if (!left && !right) return null
    const of = (r: typeof left, name: string): string =>
      r?.results.find((x) => x.name === name)?.outcome ?? 'none'
    const names = [...new Set([...(left?.results ?? []), ...(right?.results ?? [])].map((r) => r.name))]
    names.sort((x, y) => Number(v.proof.includes(y)) - Number(v.proof.includes(x)))
    return (
      <table key={title}>
        <caption>{title}</caption>
        <thead>
          <tr>
            <th scope="col">Test</th>
            <th scope="col">Base</th>
            <th scope="col">Branch</th>
          </tr>
        </thead>
        <tbody>
          {names.map((n) => (
            <tr key={n} className={v.proof.includes(n) ? 'proof' : ''}>
              <th scope="row">
                {n.split(' > ').slice(1).join(' > ')}
                <small>{n.split(' > ')[0]}</small>
              </th>
              <td className={of(left, n)}>{of(left, n)}</td>
              <td className={of(right, n)}>{of(right, n)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  })
}
