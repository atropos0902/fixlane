import { Dialog } from './Dialog.tsx'

const KEYS: [string, string][] = [
  ['arrows', 'move between tickets'],
  ['Enter', 'open a ticket'],
  ['s', 'start the ticket you are on'],
  ['n', 'new ticket'],
  ['r', 'repositories'],
  ['F6', 'leave the shell after taking over'],
  ['Esc', 'back'],
]

export function Help({ close }: { close: () => void }) {
  return (
    <Dialog title="Keyboard" close={close}>
      <dl className="keys">
        {KEYS.map(([k, what]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
      <button type="button" onClick={close}>
        Close
      </button>
    </Dialog>
  )
}
