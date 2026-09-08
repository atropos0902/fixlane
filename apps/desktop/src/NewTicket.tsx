import { type FormEvent, useState } from 'react'
import type { StateView } from '../electron/bridge.ts'
import { Dialog } from './Dialog.tsx'

interface Props {
  repos: StateView['repos']
  act: (p: Promise<unknown>) => Promise<void>
  close: () => void
}
type Kind = 'code' | 'dependency' | 'secret'

const sha256 = async (s: string): Promise<string> => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function NewTicket({ repos, act, close }: Props) {
  const [kind, setKind] = useState<Kind>('code')
  const submit = async (e: FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const at = (k: string): string => String(f.get(k) ?? '').trim()
    const key = at('key')
    await act(
      window.fixlane.file({
        id: at('id'),
        repo: at('repo'),
        kind,
        title: at('title'),
        body: at('body'),
        ...(kind === 'dependency'
          ? {
              advisory: {
                id: at('advisory'),
                package: at('package'),
                affected: at('affected'),
                text: at('body'),
              },
            }
          : {}),
        // The key is hashed here. Only its print leaves this window.
        ...(kind === 'secret' ? { key: { sha256: await sha256(key), length: key.length } } : {}),
      }),
    )
    close()
  }
  return (
    <Dialog title="New ticket" close={close}>
      <form className="fields" onSubmit={(e) => void submit(e)}>
        <label>
          Id
          <input name="id" required pattern="[a-z0-9][a-z0-9\-]{0,62}" placeholder="sec-12" />
        </label>
        <label>
          Repository
          <select name="repo">
            {repos.map((r) => (
              <option key={r.name}>{r.name}</option>
            ))}
          </select>
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            <option value="code">unsafe code</option>
            <option value="dependency">dependency</option>
            <option value="secret">leaked key</option>
          </select>
        </label>
        <label>
          Title
          <input name="title" required maxLength={200} />
        </label>
        <label>
          What is wrong
          <textarea name="body" rows={4} />
        </label>
        {kind === 'dependency' && (
          <>
            <label>
              Advisory
              <input name="advisory" required />
            </label>
            <label>
              Package
              <input name="package" required />
            </label>
            <label>
              Affected versions
              <input name="affected" required placeholder="<2.1.4" />
            </label>
          </>
        )}
        {kind === 'secret' && (
          <label>
            The key (only its hash is kept)
            <input name="key" required type="password" minLength={8} autoComplete="off" />
          </label>
        )}
        <div className="actions">
          <button type="submit" className="main">
            File it
          </button>
          <button type="button" onClick={close}>
            Cancel
          </button>
        </div>
      </form>
    </Dialog>
  )
}
