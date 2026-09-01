/**
 * Codex's app-server notifications → the stream-json vocabulary Superagent
 * already speaks.
 *
 * Everything downstream of a session — the chat renderer, the phone's wire
 * format in transcript.ts, the recap builder, the SQLite transcript — was
 * written against Claude Code's event stream. Rather than teach each of them a
 * second dialect (which is how the Antigravity branch ended up with a parallel
 * 270-line handler in the renderer and no board, browser or simulator tools),
 * a Codex session translates once, here, and every one of those keeps working
 * unchanged.
 *
 * The mapping is not lossless in principle, but it is faithful in practice:
 * Codex's item lifecycle (started → deltas → completed) is the same shape as
 * Claude's content blocks and tool_use/tool_result pairs, and its MCP calls
 * carry the `mcp__server__tool` names the renderer's tool cards already key on.
 */

export type StreamJsonEvent = Record<string, unknown>

/** How much of a background job's output to keep for the runs strip. */
const BG_OUTPUT_LIMIT = 8000

/** Codex reports a plan as a whole list each time; the panel wants create/update. */
interface PlanState {
  steps: { step: string; status: string }[]
}

/**
 * Codex wraps shell commands for its own execution (`/bin/zsh -lc "…"`, and
 * sometimes a nested `bash -lc '…'`). The user cares about what was run, not
 * how it was launched, so the wrapper comes off before it reaches a tool card.
 */
export function unwrapShellCommand(command: string): string {
  let out = command.trim()
  // Peel at most a couple of layers; a pathological command shouldn't loop.
  for (let i = 0; i < 3; i++) {
    const m = out.match(/^(?:\S*\/)?(?:ba|z|)sh\s+-[a-z]*c\s+(.+)$/is)
    if (!m) break
    const rest = m[1].trim()
    const quote = rest[0]
    if (quote !== '"' && quote !== "'") break
    // Take the balanced quoted string; anything after it is part of the command.
    let end = -1
    for (let j = 1; j < rest.length; j++) {
      if (rest[j] === '\\') {
        j++
        continue
      }
      if (rest[j] === quote) {
        end = j
        break
      }
    }
    if (end < 0) break
    const inner = rest.slice(1, end).replace(/\\(["'\\$`])/g, '$1')
    if (rest.slice(end + 1).trim()) break // trailing args: not a plain wrapper
    out = inner.trim()
  }
  return out
}

/**
 * Split a unified diff into hunks of removed/added lines.
 *
 * The renderer's diff card is built from old/new string pairs (it was written
 * for Claude's Edit and MultiEdit inputs). Codex hands a unified diff instead,
 * so we parse it back into the pairs rather than teaching the renderer a third
 * input shape — one hunk in, one hunk out, so a multi-hunk edit still renders
 * as several hunks instead of one blurred blob.
 */
export function hunksFromUnifiedDiff(diff: string): { removed: string[]; added: string[] }[] {
  const hunks: { removed: string[]; added: string[] }[] = []
  let current: { removed: string[]; added: string[] } | null = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      if (current && (current.removed.length || current.added.length)) hunks.push(current)
      current = { removed: [], added: [] }
      continue
    }
    // File headers, "\ No newline at end of file", index lines: not content.
    if (/^(---|\+\+\+|diff |index |new file|deleted file|similarity |rename |\\)/.test(line))
      continue
    if (!current) current = { removed: [], added: [] }
    if (line.startsWith('-')) current.removed.push(line.slice(1))
    else if (line.startsWith('+')) current.added.push(line.slice(1))
    else if (line.startsWith(' ')) {
      // Context. Keep it on both sides so the card shows unchanged surroundings.
      current.removed.push(line.slice(1))
      current.added.push(line.slice(1))
    }
  }
  if (current && (current.removed.length || current.added.length)) hunks.push(current)
  return hunks
}

/** Flatten an MCP result's content blocks to the text a tool_result carries. */
function mcpResultText(result: unknown): string {
  const content = (result as { content?: unknown[] } | null)?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => {
      const block = c as Record<string, unknown>
      if (typeof block?.text === 'string') return block.text
      if (block?.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

export class CodexTranslator {
  /** Item ids whose text block is currently open, so a stop is only emitted once. */
  private openText = new Set<string>()
  private openThinking = new Set<string>()
  /** Accumulated delta text per item, so a completed item can close out cleanly. */
  private text = new Map<string, string>()
  private plan: PlanState = { steps: [] }
  /**
   * Command executions that have started and not finished.
   *
   * Codex's unified_exec leaves a long-running process (a dev server, a watcher)
   * running past the end of the turn: the item simply never completes. So an
   * item still open when `turn/completed` arrives IS the background job — no
   * heuristic on the command text needed — and that is where it gets handed to
   * the runs strip.
   */
  private openCommands = new Map<
    string,
    { command: string; processId: string | null; output: string }
  >()
  /** Latest usage, attached to the next assistant/result event the meter reads. */
  private lastUsage: Record<string, number> | null = null
  private contextWindow: number | null = null
  private planSeq = 0

  /** Reset the per-turn scratch state. Called when a turn starts. */
  startTurn(): void {
    this.openText.clear()
    this.openThinking.clear()
    this.text.clear()
    this.plan = { steps: [] }
    // Deliberately NOT openCommands: a process that outlived the last turn is
    // still running, and forgetting it here is how it stops being stoppable.
  }

  /** The model context window Codex reported, if it has. */
  get modelContextWindow(): number | null {
    return this.contextWindow
  }

  /**
   * Translate one app-server notification. Returns the stream-json events to
   * forward, in order — usually one, sometimes several, often none.
   */
  handle(method: string, params: Record<string, unknown>): StreamJsonEvent[] {
    switch (method) {
      case 'item/started':
        return this.itemStarted(params.item as Record<string, unknown>)
      case 'item/completed':
        return this.itemCompleted(params.item as Record<string, unknown>)
      case 'item/agentMessage/delta':
        return this.delta(params, 'text')
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta':
        return this.delta(params, 'thinking')
      case 'item/commandExecution/outputDelta':
        return this.commandOutput(params)
      case 'turn/plan/updated':
        return this.planUpdated(params)
      case 'thread/tokenUsage/updated':
        return this.tokenUsage(params)
      case 'turn/completed':
        return this.turnCompleted(params)
      case 'error':
        return this.error(params)
      default:
        return []
    }
  }

  // --- items -------------------------------------------------------------

  private itemStarted(item: Record<string, unknown>): StreamJsonEvent[] {
    if (!item) return []
    const id = String(item.id ?? '')
    switch (item.type) {
      case 'agentMessage': {
        this.openText.add(id)
        this.text.set(id, '')
        return [blockStart({ type: 'text', text: '' })]
      }
      case 'reasoning': {
        this.openThinking.add(id)
        return [blockStart({ type: 'thinking', thinking: '' })]
      }
      case 'commandExecution': {
        this.openCommands.set(id, {
          command: unwrapShellCommand(typeof item.command === 'string' ? item.command : ''),
          processId: typeof item.processId === 'string' ? item.processId : null,
          output: ''
        })
        return [this.toolUse(id, 'Bash', commandInput(item))]
      }
      case 'fileChange':
        return fileChangeTools(item).map((t) => this.toolUse(t.id, t.name, t.input))
      case 'mcpToolCall':
        return [
          this.toolUse(id, `mcp__${String(item.server ?? 'mcp')}__${String(item.tool ?? 'tool')}`, {
            ...((item.arguments as Record<string, unknown>) ?? {})
          })
        ]
      // userMessage is our own prompt coming back; the chat already shows it.
      default:
        return []
    }
  }

  private itemCompleted(item: Record<string, unknown>): StreamJsonEvent[] {
    if (!item) return []
    const id = String(item.id ?? '')
    switch (item.type) {
      case 'agentMessage': {
        const out: StreamJsonEvent[] = []
        if (this.openText.delete(id)) out.push(blockStop())
        const text = typeof item.text === 'string' ? item.text : (this.text.get(id) ?? '')
        this.text.delete(id)
        // The assistant event both carries the final text (used when nothing
        // streamed) and is what tells the renderer to finalize the streaming row.
        out.push(this.assistant([{ type: 'text', text }]))
        return out
      }
      case 'reasoning': {
        const out: StreamJsonEvent[] = []
        if (this.openThinking.delete(id)) out.push(blockStop())
        return out
      }
      case 'commandExecution': {
        this.openCommands.delete(id)
        const output = typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : ''
        const exit = typeof item.exitCode === 'number' ? item.exitCode : null
        const failed = item.status === 'failed' || item.status === 'declined' || !!exit
        const suffix = exit ? `\n[exit ${exit}]` : ''
        return [toolResult(id, (output || '(no output)') + suffix, failed)]
      }
      case 'fileChange': {
        const declined = item.status === 'failed' || item.status === 'declined'
        return fileChangeTools(item).map((t) =>
          toolResult(t.id, declined ? 'The change was not applied.' : 'Applied.', declined)
        )
      }
      case 'mcpToolCall': {
        const err = item.error as { message?: string } | null
        const text = err?.message ? String(err.message) : mcpResultText(item.result)
        return [toolResult(id, text || (err ? 'Failed.' : 'Done.'), !!err)]
      }
      default:
        return []
    }
  }

  /**
   * Live output from a running command. Kept rather than forwarded: the chat has
   * nowhere to stream it mid-tool-call, but if this command turns out to be a
   * background job it is the only output the strip will ever get — after the
   * turn ends Codex sends nothing more about it.
   */
  private commandOutput(params: Record<string, unknown>): StreamJsonEvent[] {
    const open = this.openCommands.get(String(params.itemId ?? ''))
    const delta = typeof params.delta === 'string' ? params.delta : ''
    if (open && delta) open.output = (open.output + delta).slice(-BG_OUTPUT_LIMIT)
    return []
  }

  private delta(params: Record<string, unknown>, kind: 'text' | 'thinking'): StreamJsonEvent[] {
    const chunk = typeof params.delta === 'string' ? params.delta : ''
    if (!chunk) return []
    const itemId = String(params.itemId ?? '')
    if (kind === 'text') this.text.set(itemId, (this.text.get(itemId) ?? '') + chunk)
    return [
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta:
            kind === 'text'
              ? { type: 'text_delta', text: chunk }
              : { type: 'thinking_delta', thinking: chunk }
        }
      }
    ]
  }

  // --- plan → the Tasks panel --------------------------------------------

  /**
   * Codex sends the whole plan on every change; the Tasks panel is fed by
   * create/update calls. Diffing against the last plan turns one into the other,
   * and the synthetic tool_result carries the id the panel re-keys on — the same
   * handshake Claude's TaskCreate has.
   */
  private planUpdated(params: Record<string, unknown>): StreamJsonEvent[] {
    const steps = (params.plan as { step?: string; status?: string }[] | undefined) ?? []
    const out: StreamJsonEvent[] = []
    steps.forEach((s, i) => {
      const step = String(s.step ?? '')
      const status = planStatus(s.status)
      const known = this.plan.steps[i]
      if (!known) {
        const useId = `plan-${++this.planSeq}`
        out.push(this.toolUse(useId, 'TaskCreate', { subject: step }))
        out.push(toolResult(useId, `Task #${i + 1} created`, false))
        if (status !== 'pending') {
          const upId = `plan-${++this.planSeq}`
          out.push(this.toolUse(upId, 'TaskUpdate', { taskId: String(i + 1), status }))
          out.push(toolResult(upId, 'Task updated', false))
        }
        return
      }
      if (known.status !== status || known.step !== step) {
        const upId = `plan-${++this.planSeq}`
        out.push(this.toolUse(upId, 'TaskUpdate', { taskId: String(i + 1), status, subject: step }))
        out.push(toolResult(upId, 'Task updated', false))
      }
    })
    this.plan = {
      steps: steps.map((s) => ({ step: String(s.step ?? ''), status: planStatus(s.status) }))
    }
    return out
  }

  // --- usage and turn end -------------------------------------------------

  private tokenUsage(params: Record<string, unknown>): StreamJsonEvent[] {
    const usage = params.tokenUsage as
      | {
          last?: Record<string, number>
          total?: Record<string, number>
          modelContextWindow?: number | null
        }
      | undefined
    if (!usage) return []
    if (typeof usage.modelContextWindow === 'number') this.contextWindow = usage.modelContextWindow
    const last = usage.last
    if (last) {
      // The meter wants the size of the prompt the model just carried — Codex's
      // `last` breakdown, with cached input counted, is exactly that.
      this.lastUsage = {
        input_tokens: (last.inputTokens ?? 0) - (last.cachedInputTokens ?? 0),
        cache_read_input_tokens: last.cachedInputTokens ?? 0,
        cache_creation_input_tokens: last.cacheWriteInputTokens ?? 0,
        output_tokens: last.outputTokens ?? 0
      }
    }
    return []
  }

  private turnCompleted(params: Record<string, unknown>): StreamJsonEvent[] {
    const turn = (params.turn as Record<string, unknown>) ?? {}
    const status = String(turn.status ?? 'completed')
    const err = turn.error as { message?: string } | null
    const out: StreamJsonEvent[] = []
    // A turn can end with a block still open — an interrupt mid-sentence. Close
    // it, or the renderer leaves a message spinning forever.
    for (const id of [...this.openText]) {
      this.openText.delete(id)
      out.push(blockStop())
      out.push(this.assistant([{ type: 'text', text: this.text.get(id) ?? '' }]))
    }
    for (const id of [...this.openThinking]) {
      this.openThinking.delete(id)
      out.push(blockStop())
    }
    // Anything still executing when the turn ends is running in the background.
    // Hand it to the runs strip: it is what tells the user a dev server is up,
    // gives them a way to stop it, and — the part that loses work otherwise —
    // is what stops the idle reaper from reaping a chat that still has a live
    // process in it.
    for (const [itemId, open] of [...this.openCommands]) {
      this.openCommands.delete(itemId)
      out.push(
        this.toolUse(itemId, 'Bash', {
          command: open.command,
          run_in_background: true,
          // No shell handle to poll: after the turn ends Codex sends nothing
          // more about this process, so what we captured is all there will be.
          manual: true,
          output: open.output
        })
      )
      out.push(
        toolResult(
          itemId,
          `Still running in the background${open.processId ? ` (pid ${open.processId})` : ''}.` +
            (open.output ? `\n${open.output}` : ''),
          false
        )
      )
    }

    if (status === 'failed' || err) {
      out.push({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: err?.message ?? 'The turn failed.',
        ...(this.lastUsage ? { usage: this.lastUsage } : {})
      })
      return out
    }
    out.push({
      type: 'result',
      subtype: status === 'interrupted' ? 'error_during_execution' : 'success',
      is_error: false,
      ...(this.lastUsage ? { usage: this.lastUsage } : {})
    })
    return out
  }

  private error(params: Record<string, unknown>): StreamJsonEvent[] {
    const err = params.error as { message?: string } | undefined
    // A retryable error is Codex telling us it is handling it; saying so in the
    // transcript would be noise for something the user never needed to know.
    if (params.willRetry) return []
    return [
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        result: err?.message ?? 'Codex reported an error.'
      }
    ]
  }

  // --- shapes -------------------------------------------------------------

  private assistant(content: Record<string, unknown>[]): StreamJsonEvent {
    const usage = this.lastUsage
    return {
      type: 'assistant',
      message: { role: 'assistant', content, ...(usage ? { usage } : {}) }
    }
  }

  private toolUse(id: string, name: string, input: Record<string, unknown>): StreamJsonEvent {
    return this.assistant([{ type: 'tool_use', id, name, input }])
  }
}

function planStatus(raw: unknown): 'pending' | 'in_progress' | 'completed' {
  if (raw === 'inProgress' || raw === 'in_progress') return 'in_progress'
  if (raw === 'completed') return 'completed'
  return 'pending'
}

function blockStart(contentBlock: Record<string, unknown>): StreamJsonEvent {
  return {
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: contentBlock }
  }
}

function blockStop(): StreamJsonEvent {
  return { type: 'stream_event', event: { type: 'content_block_stop' } }
}

function toolResult(toolUseId: string, text: string, isError: boolean): StreamJsonEvent {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, is_error: isError }]
    }
  }
}

function commandInput(item: Record<string, unknown>): Record<string, unknown> {
  const raw = typeof item.command === 'string' ? item.command : ''
  return {
    command: unwrapShellCommand(raw),
    ...(typeof item.cwd === 'string' ? { cwd: item.cwd } : {})
  }
}

/**
 * One tool card per changed file.
 *
 * A whole new file renders as a Write (all additions); an edit renders as a
 * MultiEdit, whose per-edit old/new pairs the renderer already turns into one
 * hunk each — so a diff that touched three places still looks like three.
 */
function fileChangeTools(
  item: Record<string, unknown>
): { id: string; name: string; input: Record<string, unknown> }[] {
  const baseId = String(item.id ?? '')
  const changes = (item.changes as Record<string, unknown>[] | undefined) ?? []
  return changes.map((change, i) => {
    const path = String(change.path ?? '')
    const kind = (change.kind as { type?: string } | string | undefined) ?? {}
    const kindType = typeof kind === 'string' ? kind : (kind.type ?? 'update')
    const diff = typeof change.diff === 'string' ? change.diff : ''
    const hunks = hunksFromUnifiedDiff(diff)
    const id = changes.length > 1 ? `${baseId}-${i}` : baseId
    if (kindType === 'add') {
      const content = hunks.flatMap((h) => h.added).join('\n')
      return { id, name: 'Write', input: { file_path: path, content } }
    }
    return {
      id,
      name: 'MultiEdit',
      input: {
        file_path: path,
        edits: hunks.map((h) => ({
          old_string: h.removed.join('\n'),
          new_string: h.added.join('\n')
        }))
      }
    }
  })
}
