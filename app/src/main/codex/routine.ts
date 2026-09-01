import { codexExec, lastAgentMessage } from './exec'
import { unwrapShellCommand } from './translate'
import type { RoutineOutcome, RoutineRunOptions, RoutineStep } from '../agent-backend'

/**
 * One routine run on Codex.
 *
 * A routine is headless and unattended, so it needs none of what the app server
 * exists for — no streaming, no approvals, no steering. `codex exec` is the
 * simpler and more robust tool for it: one process, one turn, exits when done.
 *
 * The cost is that steps arrive only at the end rather than live. A run viewer
 * that fills in when the run finishes is a fair trade for not holding a JSON-RPC
 * server open for eight minutes of unattended work.
 */

/** Turn one `codex exec` JSONL event into transcript steps. */
export function stepsFromExecEvent(event: Record<string, unknown>): RoutineStep[] {
  if (event.type !== 'item.completed' && event.type !== 'item.started') return []
  const item = event.item as Record<string, unknown> | undefined
  if (!item) return []
  switch (item.type) {
    case 'agent_message': {
      if (event.type !== 'item.completed') return []
      const text = typeof item.text === 'string' ? item.text : ''
      return text.trim() ? [{ kind: 'text', text }] : []
    }
    case 'reasoning': {
      if (event.type !== 'item.completed') return []
      const summary = (item.summary as string[] | undefined) ?? []
      const text = summary.join('\n')
      return text.trim() ? [{ kind: 'thinking', text }] : []
    }
    case 'command_execution': {
      if (event.type !== 'item.started') return []
      const command = typeof item.command === 'string' ? unwrapShellCommand(item.command) : ''
      return [{ kind: 'tool', name: 'shell', input: command.slice(0, 200) }]
    }
    case 'file_change': {
      if (event.type !== 'item.started') return []
      const changes = (item.changes as { path?: string }[] | undefined) ?? []
      return [
        {
          kind: 'tool',
          name: 'edit',
          input: changes
            .map((c) => c.path ?? '')
            .filter(Boolean)
            .join(', ')
            .slice(0, 200)
        }
      ]
    }
    case 'mcp_tool_call': {
      if (event.type !== 'item.started') return []
      // Match the Claude runner's naming: the transcript reads "browser_navigate",
      // not the fully qualified MCP id.
      const name = String(item.tool ?? 'tool')
      let input: string | undefined
      try {
        input = item.arguments ? JSON.stringify(item.arguments).slice(0, 200) : undefined
      } catch {
        input = undefined
      }
      return [{ kind: 'tool', name, input }]
    }
    default:
      return []
  }
}

/** Sum a `turn.completed` usage block the way the dashboard counts tokens. */
export function tokensFromExecEvents(events: Record<string, unknown>[]): number {
  const done = [...events].reverse().find((e) => e.type === 'turn.completed')
  const usage = (done?.usage ?? {}) as Record<string, number>
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cached_input_tokens ?? 0) +
    (usage.cache_write_input_tokens ?? 0)
  )
}

export async function runCodexRoutine(opts: RoutineRunOptions): Promise<RoutineOutcome> {
  const res = await codexExec(`${opts.systemPrompt}\n\n---\n\n${opts.prompt}`, {
    cwd: opts.cwd,
    // A routine drives a browser and may write files in its project; it runs
    // unattended, so there is nobody to approve anything it stops for.
    sandbox: 'workspace-write',
    config: opts.mcpUrl ? { 'mcp_servers.cove-browser.url': `"${opts.mcpUrl}"` } : {},
    timeoutMs: opts.timeoutMs
  })

  const steps = res.events.flatMap(stepsFromExecEvent)
  // Nothing streamed, so the viewer gets the transcript in one go at the end.
  if (steps.length) opts.onSteps(steps)

  const summary = (res.text || lastAgentMessage(res.events)).slice(0, 500)
  return {
    ok: res.ok,
    summary: res.ok ? summary || '(no summary)' : res.error || 'The run failed.',
    steps,
    tokens: tokensFromExecEvents(res.events)
  }
}
