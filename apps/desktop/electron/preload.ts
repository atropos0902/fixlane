import { contextBridge, type IpcRendererEvent, ipcRenderer } from 'electron'
import type { Bridge, Pushed } from './bridge.ts'

const ask = <T>(name: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(name, ...args) as Promise<T>
let lines = 0

const bridge: Bridge = {
  state: () => ask('state'),
  session: (id) => ask('session', id),
  start: (ticket, runtime, moveHere) => ask('start', ticket, runtime, moveHere),
  cancel: (session) => ask('cancel', session),
  file: (ticket) => ask('file', ticket),
  comment: (ticket, text) => ask('comment', ticket, text),
  setMode: (repo, mode) => ask('setMode', repo, mode),
  openPull: (url) => ask('openPull', url),
  onPush(fn) {
    const on = (_: IpcRendererEvent, m: Pushed): void => fn(m)
    ipcRenderer.on('push', on)
    return () => ipcRenderer.off('push', on)
  },
  takeOver(session, onData, onEnd) {
    const line = ++lines
    const data = (_: IpcRendererEvent, l: number, d: string): void => {
      if (l === line) onData(d)
    }
    const end = (_: IpcRendererEvent, l: number, why: string): void => {
      if (l !== line) return
      ipcRenderer.off('term-data', data)
      ipcRenderer.off('term-end', end)
      onEnd(why)
    }
    ipcRenderer.on('term-data', data)
    ipcRenderer.on('term-end', end)
    ipcRenderer.send('term-open', line, session)
    return {
      write: (d) => ipcRenderer.send('term-write', line, d),
      resize: (cols, rows) => ipcRenderer.send('term-resize', line, cols, rows),
      hangUp: () => ipcRenderer.send('term-close', line),
    }
  },
}

contextBridge.exposeInMainWorld('fixlane', bridge)
