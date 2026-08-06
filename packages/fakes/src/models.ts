import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export type Turn = { tool: string; input: Record<string, unknown> } | { text: string }

/** Answers model calls from a script, one turn per call, in either vendor's streaming format. */
export class FakeModels {
  readonly calls: { path: string; auth: string | null; body: Record<string, unknown> }[] = []
  readonly #server: Server
  readonly #turns: Turn[]
  #next = 0

  constructor(turns: Turn[]) {
    this.#turns = turns
    this.#server = createServer(async (req, res) => {
      const parts: Buffer[] = []
      for await (const p of req) parts.push(p as Buffer)
      const path = new URL(req.url ?? '/', 'http://x').pathname
      const body = parts.length
        ? (JSON.parse(Buffer.concat(parts).toString()) as Record<string, unknown>)
        : {}
      const auth = (req.headers['x-api-key'] as string) ?? req.headers.authorization ?? null
      this.calls.push({ path, auth, body })
      if (path === '/v1/messages/count_tokens') {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}')
        return
      }
      // Both tools also ask for small things on the side (a title, a summary). Those get plain text.
      const tools = Array.isArray(body.tools) ? body.tools.length : 0
      const turn: Turn = tools === 0 ? { text: 'ok' } : (this.#turns[this.#next++] ?? { text: 'Done.' })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const events = path === '/v1/messages' ? anthropic(turn) : openai(turn)
      for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      res.end()
    })
  }

  async listen(): Promise<this> {
    await new Promise<void>((r) => this.#server.listen(0, '127.0.0.1', r))
    return this
  }
  get origin(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`
  }
  close(): void {
    this.#server.closeAllConnections()
    this.#server.close()
  }
}

let n = 0
interface Ev {
  type: string
  [k: string]: unknown
}

function anthropic(t: Turn): Ev[] {
  const block =
    'text' in t
      ? [
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t.text } },
        ]
      : [
          {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'tool_use', id: `toolu_${++n}`, name: t.tool, input: {} },
          },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input) },
          },
        ]
  const message = {
    id: `msg_${++n}`,
    type: 'message',
    role: 'assistant',
    model: 'fake',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 1000, output_tokens: 1 },
  }
  return [
    { type: 'message_start', message },
    ...block,
    { type: 'content_block_stop', index: 0 },
    {
      type: 'message_delta',
      delta: { stop_reason: 'text' in t ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { input_tokens: 1000, output_tokens: 50 },
    },
    { type: 'message_stop' },
  ]
}

function openai(t: Turn): Ev[] {
  const id = `resp_${++n}`
  let item: Record<string, unknown>
  if ('text' in t) {
    item = {
      type: 'message',
      id: `msg_${++n}`,
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: t.text, annotations: [] }],
    }
  } else {
    // Tools of an MCP server come in a namespace: "mcp__ticket/stop" means name "stop" in "mcp__ticket".
    const slash = t.tool.indexOf('/')
    const name =
      slash < 0 ? { name: t.tool } : { name: t.tool.slice(slash + 1), namespace: t.tool.slice(0, slash) }
    item = {
      type: 'function_call',
      id: `fc_${++n}`,
      call_id: `call_${n}`,
      ...name,
      arguments: JSON.stringify(t.input),
      status: 'completed',
    }
  }
  const usage = {
    input_tokens: 1000,
    output_tokens: 50,
    total_tokens: 1050,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens_details: { reasoning_tokens: 0 },
  }
  return [
    { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: { id, object: 'response', status: 'completed', output: [item], usage },
    },
  ]
}
