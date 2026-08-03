import { readFileSync } from 'node:fs'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const ticket = JSON.parse(readFileSync('/session/ticket.json', 'utf8')) as {
  id: string
  title: string
  body: string
  advisory?: { id: string; package: string; affected: string; text: string }
}
const say = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const server = new McpServer({ name: 'ticket', version: '1' })

server.registerTool('read_ticket', { description: 'The ticket you are working on.' }, () =>
  say(`${ticket.id}: ${ticket.title}\n\n${ticket.body}`),
)
server.registerTool(
  'read_advisory',
  { description: 'The security advisory behind the ticket, if it has one.' },
  () => {
    const a = ticket.advisory
    return say(a ? `${a.id}: ${a.package} ${a.affected}\n\n${a.text}` : 'This ticket has no advisory.')
  },
)
server.registerTool(
  'stop',
  {
    description:
      'End without a change, because the ticket is already fixed or cannot be fixed safely. Say why.',
    inputSchema: { reason: z.string().min(10) },
  },
  () => say('Recorded. End your turn.'),
)
await server.connect(new StdioServerTransport())
