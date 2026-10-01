/**
 * Antigravity's `stream-json` events → the stream-json vocabulary Superagent
 * already speaks.
 *
 * `agy --output-format stream-json` emits three kinds of line: one `init`, any
 * number of `step_update`s (a step is `ACTIVE` while it runs and `DONE` when it
 * finishes, or `ERROR` when its tool failed or was refused; an `agent_response` step carries `text_delta` chunks, a `tool` step
 * carries `tool_info`), and one `result` per turn. Everything downstream of a
 * session — the chat renderer, the phone's wire format, the recap builder, the
 * SQLite transcript — was written against Claude Code's events, so an
 * Antigravity session translates once, here, the same way a Codex one does in
 * codex/translate.ts, and every one of those keeps working unchanged.
 *
 * Tool calls are renamed as well as reshaped. Antigravity's `run_command` with a
 * `CommandLine` is a `Bash` with a `command` as far as a tool card is concerned,
 * and its `call_mcp_tool` wrapper is unwrapped back into the `mcp__server__tool`
 * name the cards for Superagent's own tools key on.
 *
 * Shapes are from Antigravity's headless-mode documentation and from streams
 * captured off agy 1.2.x. Every field but the discriminators is read leniently:
 * a missing one costs a detail, never the event.
 */

export type StreamJsonEvent = Record<string, unknown>

type Json = Record<string, unknown>

/** Unchanged lines kept either side of an edit, so the diff card has surroundings. */
const DIFF_CONTEXT = 3

/** Antigravity tools that change a file. Their cards are held until the step is done. */
const FILE_WRITE_TOOLS = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file'
])

function str(o: Json, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v) return v
  }
  return undefined
}

function obj(v: unknown): Json {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {}
}

/** The file a write tool is aimed at, whichever name the tool gives it. */
export function targetFile(params: Json): string | undefined {
  return str(params, 'TargetFile', 'AbsolutePath', 'FilePath', 'Path')
}

/**
 * One Antigravity tool call in the names and argument shapes the renderer's
 * tool cards were built for. Anything unrecognised passes through under its own
 * name, which still renders — as a plain card rather than a tailored one.
 */
export function mapTool(name: string, params: Json): { name: string; input: Json } {
  switch (name) {
    case 'run_command':
      return {
        name: 'Bash',
        input: {
          command: str(params, 'CommandLine') ?? '',
          ...(str(params, 'Cwd') ? { cwd: str(params, 'Cwd') } : {})
        }
      }
    case 'view_file':
      return {
        name: 'Read',
        input: {
          file_path: targetFile(params) ?? '',
          ...(typeof params.StartLine === 'number' ? { offset: params.StartLine } : {}),
          ...(typeof params.StartLine === 'number' && typeof params.EndLine === 'number'
            ? { limit: params.EndLine - params.StartLine + 1 }
            : {})
        }
      }
    case 'write_to_file':
      return {
        name: 'Write',
        input: {
          file_path: targetFile(params) ?? '',
          ...(str(params, 'CodeContent', 'Content') !== undefined
            ? { content: str(params, 'CodeContent', 'Content') }
            : {})
        }
      }
    case 'replace_file_content':
    case 'sed_file':
      return {
        name: 'Edit',
        input: {
          file_path: targetFile(params) ?? '',
          ...(typeof params.TargetContent === 'string' ? { old_string: params.TargetContent } : {}),
          ...(typeof params.ReplacementContent === 'string'
            ? { new_string: params.ReplacementContent }
            : {})
        }
      }
    case 'multi_replace_file_content': {
      const chunks = Array.isArray(params.ReplacementChunks) ? params.ReplacementChunks : []
      const edits = chunks
        .map(obj)
        .filter(
          (c) => typeof c.TargetContent === 'string' || typeof c.ReplacementContent === 'string'
        )
        .map((c) => ({
          old_string: typeof c.TargetContent === 'string' ? c.TargetContent : '',
          new_string: typeof c.ReplacementContent === 'string' ? c.ReplacementContent : ''
        }))
      return edits.length
        ? { name: 'MultiEdit', input: { file_path: targetFile(params) ?? '', edits } }
        : { name: 'Edit', input: { file_path: targetFile(params) ?? '' } }
    }
    case 'list_dir':
      return { name: 'LS', input: { path: str(params, 'DirectoryPath') ?? '' } }
    case 'find_by_name':
      return {
        name: 'Glob',
        input: {
          pattern: str(params, 'Pattern') ?? '',
          ...(str(params, 'SearchDirectory') ? { path: str(params, 'SearchDirectory') } : {})
        }
      }
    case 'grep_search':
      return {
        name: 'Grep',
        input: {
          pattern: str(params, 'Query', 'Pattern') ?? '',
          ...(str(params, 'SearchPath') ? { path: str(params, 'SearchPath') } : {})
        }
      }
    case 'search_web':
      return { name: 'WebSearch', input: { query: str(params, 'query', 'Query') ?? '' } }
    case 'read_url_content':
      return { name: 'WebFetch', input: { url: str(params, 'Url', 'URL') ?? '' } }
    case 'call_mcp_tool': {
      // Antigravity reaches every MCP server through this one wrapper. Unwrapped,
      // a call to Superagent's own server carries the same `mcp__cove-browser__…`
      // name it has on Claude Code and Codex, so its card and the taint gate that
      // watches the browser tools both recognise it.
      const server = str(params, 'ServerName') ?? 'mcp'
      const tool = str(params, 'ToolName') ?? 'tool'
      let args = params.Arguments
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args)
        } catch {
          args = { arguments: args }
        }
      }
      return { name: `mcp__${server}__${tool}`, input: obj(args) }
    }
    case 'invoke_subagent': {
      const subs = (Array.isArray(params.Subagents) ? params.Subagents : []).map(obj)
      const roles = subs.map((s) => str(s, 'Role', 'TypeName')).filter(Boolean)
      return {
        name: 'Task',
        input: {
          description: roles.join(', ') || 'subagent',
          prompt: subs
            .map((s) => str(s, 'Prompt') ?? '')
            .filter(Boolean)
            .join('\n\n'),
          subagent_type: str(subs[0] ?? {}, 'TypeName') ?? 'subagent'
        }
      }
    }
    default:
      return { name, input: params }
  }
}

function lines(text: string): string[] {
  if (!text) return []
  const out = text.split('\n')
  // A trailing newline ends the last line rather than starting an empty one.
  if (out[out.length - 1] === '') out.pop()
  return out
}

/**
 * The part of a file an edit changed, with a little of what surrounds it.
 *
 * The stream names the file an edit touched but not what it did to it (a
 * captured `replace_file_content` step carries `TargetFile` alone), so the diff
 * card is built from the file before and after instead. The common head and tail
 * come off, which leaves the one region that moved. Null when nothing changed.
 */
export function changedRegion(
  before: string,
  after: string
): { old_string: string; new_string: string } | null {
  if (before === after) return null
  const a = lines(before)
  const b = lines(after)
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++
  const from = Math.max(0, head - DIFF_CONTEXT)
  const keepTail = Math.max(0, tail - DIFF_CONTEXT)
  return {
    old_string: a.slice(from, a.length - keepTail).join('\n'),
    new_string: b.slice(from, b.length - keepTail).join('\n')
  }
}

/** Antigravity's usage block in the field names the context meter reads. */
function mapUsage(raw: unknown): Record<string, number> | null {
  const u = obj(raw)
  const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
  if (!n('input_tokens') && !n('output_tokens') && !n('cache_read_tokens')) return null
  return {
    // `input_tokens` is what was not served from cache: a second turn reports a
    // few hundred of them beside tens of thousands of `cache_read_tokens`.
    input_tokens: n('input_tokens'),
    cache_read_input_tokens: n('cache_read_tokens'),
    cache_creation_input_tokens: 0,
    output_tokens: n('output_tokens')
  }
}

export interface AntigravityTranslatorOptions {
  /**
   * Read a file's text, or null if it is missing or not worth diffing. Injected
   * so the translator itself touches no disk; without it an edit still gets a
   * card, just not a diff.
   */
  readFile?: (path: string) => string | null
}

export class AntigravityTranslator {
  private conversation = ''
  /** The agent_response step whose text block is open, if any. */
  private openStep: number | null = null
  private text = ''
  /** Tool steps whose card has been sent and whose result has not. */
  private running = new Set<number>()
  /** File edits waiting for DONE, with the file as it was before. */
  private held = new Map<number, { name: string; params: Json; before: string | null }>()
  /** Steps already closed, so a repeated DONE does not answer a card twice. */
  private finished = new Set<number>()
  /** The prompt the model last carried — what the context meter shows. */
  private lastUsage: Record<string, number> | null = null
  /** Everything this turn processed — what the turn is stamped with. */
  private turnUsage: Record<string, number> | null = null
  private spoke = false

  constructor(private readonly opts: AntigravityTranslatorOptions = {}) {}

  /** The conversation id Antigravity issued, once it has. */
  get conversationId(): string {
    return this.conversation
  }

  /** Translate one line of agy's stdout. Usually one event out, often none. */
  handle(line: Json): StreamJsonEvent[] {
    switch (line.event) {
      case 'init':
        return this.init(line)
      case 'step_update':
        return this.step(obj(line.step_update))
      case 'result':
        return this.result(obj(line.result))
      default:
        return []
    }
  }

  /**
   * End a turn that will never get its `result` — the process was interrupted or
   * died. Closes what is open so nothing is left spinning, and reports the turn
   * the way a real result would have.
   */
  abortTurn(interrupted: boolean, reason?: string): StreamJsonEvent[] {
    return this.result({
      status: interrupted ? 'INTERRUPTED' : 'ERROR',
      error: interrupted ? 'interrupted' : reason || 'Antigravity stopped before the turn finished.'
    })
  }

  // --- init ----------------------------------------------------------------

  private init(line: Json): StreamJsonEvent[] {
    const init = obj(line.init)
    const id = typeof line.conversation_id === 'string' ? line.conversation_id : ''
    if (id) this.conversation = id
    return [
      {
        type: 'system',
        subtype: 'init',
        ...(id ? { session_id: id } : {}),
        ...(str(init, 'model') ? { model: str(init, 'model') } : {}),
        ...(str(init, 'cwd') ? { cwd: str(init, 'cwd') } : {}),
        ...(Array.isArray(init.tools) ? { tools: init.tools } : {}),
        ...(str(init, 'permission_mode') ? { permission_mode: str(init, 'permission_mode') } : {})
      }
    ]
  }

  // --- steps ---------------------------------------------------------------

  private step(su: Json): StreamJsonEvent[] {
    const index = typeof su.step_index === 'number' ? su.step_index : -1
    // A step ends DONE, or ERROR when its tool failed or was refused (a hook's
    // deny arrives this way). Either way it is over and its card needs closing.
    const done = su.state === 'DONE' || su.state === 'ERROR' || su.state === 'CANCELED'
    if (typeof su.conversation_id === 'string' && su.conversation_id)
      this.conversation = su.conversation_id
    switch (su.step_type) {
      case 'agent_response':
        return this.response(index, done, su)
      case 'tool':
        return done ? this.toolDone(index, su) : this.toolActive(index, su)
      case 'subagent':
        // The same step as the `invoke_subagent` tool line, reported once its
        // children are dispatched: they are running, which is the card's result.
        return done ? this.subagentDone(index, su) : []
      // user_input is our own prompt coming back; checkpoint and system_message
      // are Antigravity's bookkeeping. None of them is something to show.
      default:
        return []
    }
  }

  private response(index: number, done: boolean, su: Json): StreamJsonEvent[] {
    const out: StreamJsonEvent[] = []
    const delta = typeof su.text_delta === 'string' ? su.text_delta : ''
    const usage = mapUsage(su.usage)
    if (usage) {
      this.lastUsage = usage
      const sum = this.turnUsage ?? {}
      for (const [k, v] of Object.entries(usage)) sum[k] = (sum[k] ?? 0) + v
      this.turnUsage = sum
    }
    if (delta) {
      if (this.openStep !== index) {
        out.push(...this.closeText())
        this.openStep = index
        this.text = ''
        out.push(blockStart({ type: 'text', text: '' }))
      }
      this.text += delta
      this.spoke = true
      out.push({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: delta } }
      })
    }
    // A response step that carried no text is the model thinking before a tool
    // call: nothing to show, and nothing was opened for it.
    if (done && this.openStep === index) out.push(...this.closeText())
    return out
  }

  /** Close the open text block, if there is one, and send its final message. */
  private closeText(): StreamJsonEvent[] {
    if (this.openStep === null) return []
    this.openStep = null
    const text = this.text
    this.text = ''
    // The assistant event both carries the final text and is what tells the
    // renderer to finalize the streaming row.
    return [blockStop(), this.assistant([{ type: 'text', text }])]
  }

  private toolId(index: number): string {
    // Step indexes restart when a conversation is replaced by a fresh one, and a
    // card's id has to stay unique within the chat on screen.
    return `agy-${this.conversation.slice(0, 8) || 'run'}-${index}`
  }

  private toolActive(index: number, su: Json): StreamJsonEvent[] {
    if (this.running.has(index) || this.held.has(index) || this.finished.has(index)) return []
    const info = obj(su.tool_info)
    const name = str(su, 'tool_name') ?? str(info, 'name') ?? 'tool'
    const params = obj(info.parameters)
    const out = this.closeText()
    if (FILE_WRITE_TOOLS.has(name)) {
      // Held until DONE: the diff is the file after against the file now.
      const path = targetFile(params)
      this.held.set(index, {
        name,
        params,
        before: path && this.opts.readFile ? this.opts.readFile(path) : null
      })
      return out
    }
    this.running.add(index)
    const mapped = mapTool(name, params)
    out.push(this.toolUse(this.toolId(index), mapped.name, mapped.input))
    return out
  }

  private toolDone(index: number, su: Json): StreamJsonEvent[] {
    if (this.finished.has(index)) return []
    const info = obj(su.tool_info)
    const name = str(su, 'tool_name') ?? str(info, 'name') ?? 'tool'
    const params = obj(info.parameters)
    const id = this.toolId(index)
    const out = this.closeText()

    const held = this.held.get(index)
    if (held) {
      this.held.delete(index)
      const edit = this.fileEdit(held.name, { ...held.params, ...params }, held.before)
      out.push(this.toolUse(id, edit.name, edit.input))
    } else if (!this.running.has(index)) {
      // A step short enough to be reported only once it was over.
      const mapped = mapTool(name, params)
      out.push(this.toolUse(id, mapped.name, mapped.input))
    }
    this.running.delete(index)
    this.finished.add(index)

    const error = obj(info.error)
    const failed = !!info.error || su.state === 'ERROR' || su.state === 'CANCELED'
    const said =
      (failed ? (str(error, 'message') ?? str(info, 'error')) : undefined) ?? str(info, 'output')
    out.push(toolResult(id, said ?? (failed ? 'Failed.' : 'Done.'), failed))
    return out
  }

  private subagentDone(index: number, su: Json): StreamJsonEvent[] {
    if (this.finished.has(index)) return []
    const subs = obj(su.subagent_info).subagents
    const list = (Array.isArray(subs) ? subs : []).map(obj)
    const id = this.toolId(index)
    const out = this.closeText()
    if (!this.running.has(index)) {
      const roles = list.map((s) => str(s, 'role', 'type_name')).filter(Boolean)
      out.push(
        this.toolUse(id, 'Task', {
          description: roles.join(', ') || 'subagent',
          prompt: list
            .map((s) => str(s, 'initial_prompt') ?? '')
            .filter(Boolean)
            .join('\n\n'),
          subagent_type: str(list[0] ?? {}, 'type_name') ?? 'subagent'
        })
      )
    }
    this.running.delete(index)
    this.finished.add(index)
    const names = list.map((s) => str(s, 'role', 'type_name') ?? 'subagent')
    out.push(
      toolResult(
        id,
        names.length
          ? `Started ${names.length === 1 ? 'a subagent' : `${names.length} subagents`}: ${names.join(', ')}.`
          : 'Subagents started.',
        false
      )
    )
    return out
  }

  /**
   * The card for a finished file edit. What the stream itself said about the
   * change wins; failing that, the file before and after says it.
   */
  private fileEdit(
    name: string,
    params: Json,
    before: string | null
  ): { name: string; input: Json } {
    const mapped = mapTool(name, params)
    const input = mapped.input
    const said =
      'content' in input || 'old_string' in input || 'new_string' in input || 'edits' in input
    const path = targetFile(params)
    if (said || !path || !this.opts.readFile) return mapped
    const after = this.opts.readFile(path)
    if (after === null) return mapped
    // No file before: all of it is new, which is what a Write card shows.
    if (before === null) return { name: 'Write', input: { file_path: path, content: after } }
    const region = changedRegion(before, after)
    return region ? { name: 'Edit', input: { file_path: path, ...region } } : mapped
  }

  // --- turn end ------------------------------------------------------------

  private result(result: Json): StreamJsonEvent[] {
    const out = this.closeText()
    // An edit that never reached DONE still gets its card, and every card still
    // open gets an answer — a turn must not end with one left spinning.
    for (const [index, held] of [...this.held]) {
      this.held.delete(index)
      this.running.add(index)
      const mapped = mapTool(held.name, held.params)
      out.push(this.toolUse(this.toolId(index), mapped.name, mapped.input))
    }
    const status = typeof result.status === 'string' ? result.status : 'SUCCESS'
    const error = typeof result.error === 'string' ? result.error : ''
    const interrupted = error === 'interrupted' || status === 'INTERRUPTED' || status === 'CANCELED'
    const ok = status === 'SUCCESS'
    for (const index of [...this.running]) {
      this.running.delete(index)
      this.finished.add(index)
      out.push(
        toolResult(
          this.toolId(index),
          ok ? 'Still running when the turn ended.' : 'Stopped before it finished.',
          !ok
        )
      )
    }

    const response = typeof result.response === 'string' ? result.response : ''
    // A turn answered without streaming (a short reply can arrive whole) still
    // has to put its text on screen.
    if (ok && !this.spoke && response.trim()) {
      out.push(this.assistant([{ type: 'text', text: response }]))
    }
    const usage = this.turnUsage
    this.turnUsage = null
    this.spoke = false

    out.push({
      type: 'result',
      subtype: ok ? 'success' : 'error_during_execution',
      is_error: !ok && !interrupted,
      ...(ok
        ? {}
        : {
            result: interrupted ? 'interrupted' : error || `Antigravity ended the turn (${status}).`
          }),
      ...(usage ? { usage } : {})
    })
    return out
  }

  // --- shapes --------------------------------------------------------------

  private assistant(content: Json[]): StreamJsonEvent {
    const usage = this.lastUsage
    return {
      type: 'assistant',
      message: { role: 'assistant', content, ...(usage ? { usage } : {}) }
    }
  }

  private toolUse(id: string, name: string, input: Json): StreamJsonEvent {
    return this.assistant([{ type: 'tool_use', id, name, input }])
  }
}

function blockStart(contentBlock: Json): StreamJsonEvent {
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

/** One line of agy's stdout as an object, or null for anything that is not an event. */
export function parseAgyLine(raw: string): Json | null {
  const line = raw.trim()
  if (!line.startsWith('{')) return null
  try {
    const parsed = JSON.parse(line)
    return parsed && typeof parsed === 'object' && typeof parsed.event === 'string' ? parsed : null
  } catch {
    return null
  }
}

/** One user turn, as agy reads it on stdin. Text is the only block type it accepts. */
export function encodeUserTurn(text: string): string {
  return JSON.stringify({ event: 'user', message: { content: [{ type: 'text', text }] } }) + '\n'
}
