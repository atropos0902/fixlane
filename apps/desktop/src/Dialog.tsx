import { type ReactNode, useEffect, useRef } from 'react'

export function Dialog({
  title,
  close,
  children,
}: {
  title: string
  close: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const d = ref.current!
    const before = document.activeElement as HTMLElement | null
    d.showModal()
    return () => {
      d.close()
      before?.focus()
    }
  }, [])
  return (
    <dialog ref={ref} aria-labelledby="dialog-title" onCancel={close}>
      <h2 id="dialog-title">{title}</h2>
      {children}
    </dialog>
  )
}
