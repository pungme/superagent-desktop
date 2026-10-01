import { join } from 'path'
import { app } from 'electron'
import { agyRun } from './exec'
import { claimSidecar, releaseSidecar, sidecarName, writeSidecar } from './sidecar'
import type { StreamJsonEvent } from './translate'
import type { RoutineOutcome, RoutineRunOptions, RoutineStep } from '../agent-backend'

/**
 * One routine run on Antigravity.
 *
 * A routine is headless and unattended, so it is one `agy` turn with every tool
 * approved — there is nobody to ask. Unlike Codex's one-shot mode, agy's stream
 * reports each step as it happens, so the run viewer fills in live.
 */

/** Turn one translated event into transcript steps. */
export function stepsFromEvent(event: StreamJsonEvent): RoutineStep[] {
  if (event.type !== 'assistant') return []
  const content = (event.message as { content?: Record<string, unknown>[] } | undefined)?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block): RoutineStep[] => {
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : ''
      return text.trim() ? [{ kind: 'text', text }] : []
    }
    if (block.type === 'tool_use') {
      // Match the other runners' naming: the transcript reads "browser_navigate",
      // not the fully qualified MCP id.
      const name = String(block.name ?? 'tool').replace(/^mcp__.+?__/, '')
      let input: string | undefined
      try {
        input = block.input ? JSON.stringify(block.input).slice(0, 200) : undefined
      } catch {
        input = undefined
      }
      return [{ kind: 'tool', name, input }]
    }
    return []
  })
}

/** What the run spent, the way the dashboard counts tokens. */
export function tokensFromEvents(events: StreamJsonEvent[]): number {
  const done = [...events].reverse().find((e) => e.type === 'result')
  const usage = (done?.usage ?? {}) as Record<string, number>
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  )
}

export async function runAntigravityRoutine(opts: RoutineRunOptions): Promise<RoutineOutcome> {
  // The pane's own folder, so the run's browser tools drive the offscreen pane
  // this routine was given. No hook: a routine approves everything.
  const dir = join(
    process.env.COVE_USER_DATA || app.getPath('userData'),
    'antigravity',
    sidecarName(`routine-${opts.paneId}`)
  )
  claimSidecar(dir)
  let sidecar: string | undefined
  try {
    sidecar = writeSidecar({ dir, mcpUrl: opts.mcpUrl || undefined })
  } catch {
    sidecar = undefined
  }

  const steps: RoutineStep[] = []
  try {
    const res = await agyRun(
      `<system_instructions>\n${opts.systemPrompt}\n</system_instructions>\n\n${opts.prompt}`,
      {
        cwd: opts.cwd,
        addDirs: sidecar ? [sidecar] : [],
        skipPermissions: true,
        plainText: true,
        timeoutMs: opts.timeoutMs,
        onEvent: (event) => {
          const added = stepsFromEvent(event)
          if (!added.length) return
          steps.push(...added)
          opts.onSteps([...steps])
        }
      }
    )
    const summary = res.text.slice(0, 500)
    return {
      ok: res.ok,
      summary: res.ok ? summary || '(no summary)' : res.error || 'The run failed.',
      steps,
      tokens: tokensFromEvents(res.events)
    }
  } finally {
    releaseSidecar(dir)
  }
}
