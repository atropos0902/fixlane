import { query } from '@anthropic-ai/claude-agent-sdk'
import { type Adapter, clip, MCP, MODEL_PORT } from '../adapter.ts'

export const claude: Adapter = {
  async run(spec, emit, over) {
    const abort = new AbortController()
    over.addEventListener('abort', () => abort.abort())
    const messages = query({
      prompt: spec.prompt,
      options: {
        cwd: '/work',
        abortController: abort,
        model: spec.model ?? 'sonnet',
        // The container is the boundary, so there is nobody to ask for permission in here.
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        // The repository may carry its own settings, hooks and instructions. None of them apply.
        settingSources: [],
        disallowedTools: ['WebFetch', 'WebSearch', 'Task'],
        mcpServers: { ticket: { type: 'stdio', ...MCP } },
        systemPrompt: { type: 'preset', preset: 'claude_code' },
        maxTurns: 60,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${MODEL_PORT}`,
          ANTHROPIC_API_KEY: 'held-by-the-daemon',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
          npm_config_registry: process.env.npm_config_registry,
        },
      },
    })
    for await (const m of messages) {
      if (m.type === 'assistant') {
        for (const b of m.message.content) {
          if (b.type === 'text') emit({ t: 'text', text: clip(b.text) })
          if (b.type === 'tool_use') {
            emit({ t: 'tool', name: b.name, input: clip(b.input) })
            if (b.name === 'mcp__ticket__stop') {
              emit({ t: 'stop', reason: clip((b.input as { reason?: string }).reason ?? '') })
              return
            }
          }
        }
      } else if (m.type === 'user' && Array.isArray(m.message.content)) {
        for (const b of m.message.content) {
          if (typeof b === 'object' && b.type === 'tool_result') emit({ t: 'output', text: clip(b.content) })
        }
      } else if (m.type === 'result' && m.is_error) {
        throw new Error(m.subtype === 'success' ? clip(m.result) : m.subtype)
      }
    }
  },
}
