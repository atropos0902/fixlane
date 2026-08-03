// One JSON line per test. What the tests print themselves is left out.
import { relative } from 'node:path'

export default async function* (source) {
  const open = new Map()
  for await (const { type, data } of source) {
    if (type !== 'test:start' && type !== 'test:pass' && type !== 'test:fail') continue
    const file = data.file ? relative(process.cwd(), data.file) : '?'
    const stack = open.get(file) ?? []
    open.set(file, stack)
    if (type === 'test:start') {
      stack.length = data.nesting
      stack[data.nesting] = data.name
      continue
    }
    if (data.details?.type === 'suite') continue
    const name = [...stack.slice(0, data.nesting), data.name].join(' / ')
    const skip = data.skip !== undefined || data.todo !== undefined
    const error = data.details?.error
    const assertion = error?.failureType === 'testCodeFailure' && error?.cause?.code === 'ERR_ASSERTION'
    const outcome = skip ? 'skip' : type === 'test:pass' ? 'pass' : 'fail'
    yield `${JSON.stringify({ file, name, outcome, assertion: outcome === 'fail' && assertion })}\n`
  }
}
