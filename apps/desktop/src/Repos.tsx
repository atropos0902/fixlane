import type { StateView } from '../electron/bridge.ts'
import { Dialog } from './Dialog.tsx'

interface Props {
  repos: StateView['repos']
  act: (p: Promise<unknown>) => Promise<void>
  close: () => void
}

export function Repos({ repos, act, close }: Props) {
  return (
    <Dialog title="Repositories" close={close}>
      <p>On “branch only” nothing is proposed. A switch reaches sessions that are already running.</p>
      <ul className="repos">
        {repos.map((r) => (
          <li key={r.name}>
            <span>
              {r.name} <small>{r.project}</small>
            </span>
            <select
              aria-label={`Mode of ${r.name}`}
              value={r.mode}
              onChange={(e) => void act(window.fixlane.setMode(r.name, e.target.value as 'branch' | 'pr'))}
            >
              <option value="branch">branch only</option>
              <option value="pr">pull requests</option>
            </select>
          </li>
        ))}
      </ul>
      <button type="button" onClick={close}>
        Close
      </button>
    </Dialog>
  )
}
