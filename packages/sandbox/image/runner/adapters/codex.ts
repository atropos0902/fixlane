import { Codex } from '@openai/codex-sdk'
import { type Adapter, clip, MCP, MODEL_PORT } from '../adapter.ts'

export const codex: Adapter = {
  async run(spec, emit, over) {
    const client = new Codex({
      apiKey: 'held-by-the-daemon',
      config: {
        model_provider: 'daemon',
        model_providers: {
          daemon: {
            name: 'daemon',
            base_url: `http://127.0.0.1:${MODEL_PORT}/v1`,
            wire_api: 'responses',
            env_key: 'CODEX_API_KEY',
            supports_websockets: false,
          },
        },
        mcp_servers: { ticket: MCP },
        check_for_update_on_startup: false,
        analytics: { enabled: false },
        // The repository may carry its own AGENTS.md. It does not apply.
        project_doc_max_bytes: 0,
        web_search: 'disabled',
      },
    })
    const thread = client.startThread({
      workingDirectory: '/work',
      // The container is the boundary. A second sandbox inside it would need rights we took away.
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      ...(spec.model ? { model: spec.model } : {}),
    })
    const { events } = await thread.runStreamed(spec.prompt, { signal: over })
    for await (const e of events) {
      if (e.type === 'item.started' && e.item.type === 'command_execution') {
        emit({ t: 'tool', name: 'shell', input: clip(e.item.command) })
      } else if (e.type === 'item.started' && e.item.type === 'mcp_tool_call') {
        emit({ t: 'tool', name: `${e.item.server}.${e.item.tool}`, input: clip(e.item.arguments) })
        if (e.item.server === 'ticket' && e.item.tool === 'stop') {
          emit({ t: 'stop', reason: clip((e.item.arguments as { reason?: string }).reason ?? '') })
          return
        }
      } else if (e.type === 'item.completed') {
        if (e.item.type === 'agent_message') emit({ t: 'text', text: clip(e.item.text) })
        if (e.item.type === 'command_execution') emit({ t: 'output', text: clip(e.item.aggregated_output) })
        if (e.item.type === 'file_change') {
          emit({
            t: 'tool',
            name: 'patch',
            input: clip(e.item.changes.map((c) => `${c.kind} ${c.path}`).join(', ')),
          })
        }
      } else if (e.type === 'turn.failed') {
        throw new Error(e.error.message)
      } else if (e.type === 'error') {
        throw new Error(e.message)
      }
    }
  },
}
