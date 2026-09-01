import { spawn } from 'child_process'
import { getHookUrl } from '../hooks'
import { findClaude } from '../claude-cli'
import type { RoutineOutcome, RoutineRunOptions, RoutineStep } from '../agent-backend'

/**
 * One routine run on Claude Code: a headless `claude -p` scoped to an offscreen
 * browser pane. Steps are streamed out as they arrive, so the run viewer updates
 * live rather than sitting blank for minutes.
 */

/** Pull the readable steps out of one stream-json `assistant` event. */
export function stepsFromAssistant(event: {
  message?: { content?: Array<Record<string, unknown>> }
}): RoutineStep[] {
  const content = event.message?.content
  if (!Array.isArray(content)) return []
  const steps: RoutineStep[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      steps.push({ kind: 'text', text: block.text })
    } else if (
      block.type === 'thinking' &&
      typeof block.thinking === 'string' &&
      block.thinking.trim()
    ) {
      steps.push({ kind: 'thinking', text: block.thinking })
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      // Strip the mcp__cove-browser__ prefix so the tool reads as e.g. "browser_navigate".
      const name = block.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')
      let input: string | undefined
      try {
        input = block.input ? JSON.stringify(block.input).slice(0, 200) : undefined
      } catch {
        input = undefined
      }
      steps.push({ kind: 'tool', name, input })
    }
  }
  return steps
}

/**
 * The full cove-browser tool set. Omissions bite: a routine that tried
 * browser_evaluate to verify its work got every call denied and looped until it
 * timed out. Keep this in sync with the tools mcp.ts registers.
 */
const ALLOWED_TOOLS = [
  'mcp__cove-browser__browser_navigate',
  'mcp__cove-browser__browser_read_page',
  'mcp__cove-browser__browser_click',
  'mcp__cove-browser__browser_type',
  'mcp__cove-browser__browser_press_key',
  'mcp__cove-browser__browser_screenshot',
  'mcp__cove-browser__browser_evaluate',
  'mcp__cove-browser__browser_console',
  'mcp__cove-browser__browser_network',
  'mcp__cove-browser__browser_wait_for'
]

export function runClaudeRoutine(opts: RoutineRunOptions): Promise<RoutineOutcome> {
  return new Promise((resolve) => {
    const proc = spawn(
      findClaude(),
      [
        '-p',
        opts.prompt,
        // stream-json (not plain json) so we capture the thinking + tool calls as
        // they happen, for the run transcript the user can inspect.
        '--output-format',
        'stream-json',
        '--verbose',
        '--append-system-prompt',
        opts.systemPrompt,
        '--mcp-config',
        opts.mcpConfigPath,
        '--max-turns',
        String(opts.maxTurns),
        // Variadic, so this must stay last — it would otherwise swallow whatever
        // follows as tool names.
        '--allowedTools',
        ...ALLOWED_TOOLS
      ],
      {
        cwd: opts.cwd,
        env: {
          ...process.env,
          COVE_HOOK_URL: getHookUrl(),
          COVE_WORKSPACE_ID: opts.paneId
        }
      }
    )

    const steps: RoutineStep[] = []
    let summary = '(no summary)'
    let isError = false
    let tokens = 0
    let buffer = ''

    const consume = (chunk: string): void => {
      buffer += chunk
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line)
          if (event?.type === 'assistant') {
            const added = stepsFromAssistant(event)
            if (added.length) {
              steps.push(...added)
              opts.onSteps(steps)
            }
          } else if (event?.type === 'result') {
            if (typeof event.result === 'string' && event.result.trim()) {
              summary = event.result.slice(0, 500)
            }
            isError = event.is_error === true
            const u = event.usage
            if (u && typeof u === 'object') {
              tokens =
                (u.input_tokens ?? 0) +
                (u.output_tokens ?? 0) +
                (u.cache_creation_input_tokens ?? 0) +
                (u.cache_read_input_tokens ?? 0)
            }
          }
        } catch {
          // partial or non-JSON line; ignore
        }
      }
    }

    const timer = setTimeout(() => {
      proc.kill()
      resolve({
        ok: false,
        summary: `Timed out after ${Math.round(opts.timeoutMs / 60000)} minutes.`,
        steps,
        tokens
      })
    }, opts.timeoutMs)

    proc.stdin.on('error', () => {})
    proc.stdout.on('data', (c) => consume(c.toString()))
    proc.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, summary: `Failed to launch: ${e.message}`, steps, tokens })
    })
    proc.on('exit', () => {
      clearTimeout(timer)
      resolve({ ok: !isError, summary, steps, tokens })
    })
  })
}
