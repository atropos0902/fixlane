import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { type Adapter, clip, type Emit } from '../adapter.ts'

type Step =
  | { say: string }
  | { write: string; text: string }
  | { edit: string; find: string; put: string }
  | { run: string }
  | { sleep: number }
  | { stop: string }
  | { fail: string }

const run = (cmd: string, emit: Emit): Promise<void> =>
  new Promise((done) => {
    const p = spawn('sh', ['-c', cmd], { cwd: '/work', stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const add = (d: Buffer): void => {
      out += d
    }
    p.stdout.on('data', add)
    p.stderr.on('data', add)
    p.on('exit', (code) => {
      emit({ t: 'output', text: clip(`${out}${code ? `\n(exit ${code})` : ''}`) })
      done()
    })
  })

/** Plays a recorded session again: same edits, same commands, no model. */
export const replay: Adapter = {
  async run(_spec, emit, over) {
    const steps = JSON.parse(readFileSync('/session/replay.json', 'utf8')) as Step[]
    for (const s of steps) {
      if (over.aborted) return
      if ('say' in s) emit({ t: 'text', text: s.say })
      else if ('sleep' in s) await sleep(s.sleep)
      else if ('fail' in s) throw new Error(s.fail)
      else if ('stop' in s) {
        emit({ t: 'stop', reason: s.stop })
        return
      } else if ('run' in s) {
        emit({ t: 'tool', name: 'shell', input: s.run })
        await run(s.run, emit)
      } else if ('write' in s) {
        emit({ t: 'tool', name: 'write', input: s.write })
        const path = resolve('/work', s.write)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, s.text)
      } else {
        emit({ t: 'tool', name: 'edit', input: s.edit })
        const path = resolve('/work', s.edit)
        const text = readFileSync(path, 'utf8')
        if (text.split(s.find).length !== 2)
          throw new Error(`${s.edit}: the text to replace is not there exactly once`)
        writeFileSync(
          path,
          text.replace(s.find, () => s.put),
        )
      }
    }
  },
}
