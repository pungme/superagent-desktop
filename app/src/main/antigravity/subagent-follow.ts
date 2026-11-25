import { closeSync, openSync, readSync, statSync } from 'fs'
import { mapTool, type StreamJsonEvent } from './translate'

/**
 * What an Antigravity sub-agent does, read from the transcript it writes.
 *
 * agy's stream says only that a sub-agent was dispatched (`subagent_info`, with
 * the child's `conversation_id` and a `log_uri`); its own steps never come
 * through the parent's stream. Its transcript does have them, one JSON line per
 * step (captured off agy 1.2.16):
 *
 *   PLANNER_RESPONSE  the model's turn: `tool_calls` [{name, args}] and/or `content`
 *   GENERIC           a tool call's result, in the order the calls were made
 *   SYSTEM_MESSAGE    its brief, or a message from the parent
 *
 * `args` values are JSON-encoded strings ("\"ls -la\""). These become the same
 * events Claude streams for a sub-agent, tagged `parent_tool_use_id` with the
 * card that started it, so the "Running in background" pill and its panel
 * (shared/subagent-activity.ts) work unchanged. A PLANNER_RESPONSE with no tool
 * calls is the sub-agent ending its turn: it is done.
 */

type Json = Record<string, unknown>

/** One transcript's steps → events. Pure apart from the ids it hands out. */
export class ChildTranscript {
  /** Tool calls made and not yet answered, oldest first. */
  private pending: string[] = []
  private seen = new Set<number>()
  done = false

  constructor(
    private readonly parent: string,
    private readonly key: string
  ) {}

  feed(line: Json): StreamJsonEvent[] {
    const index = typeof line.step_index === 'number' ? line.step_index : -1
    if (index >= 0) {
      if (this.seen.has(index)) return []
      this.seen.add(index)
    }
    const type = line.type
    if (type === 'PLANNER_RESPONSE') {
      const blocks: Json[] = []
      if (typeof line.thinking === 'string' && line.thinking.trim())
        blocks.push({ type: 'thinking', thinking: line.thinking })
      const calls = Array.isArray(line.tool_calls) ? (line.tool_calls as Json[]) : []
      calls.forEach((c, i) => {
        const name = typeof c.name === 'string' ? c.name : 'tool'
        const mapped = mapTool(name, decodeArgs(c.args))
        const id = `${this.key}-${index}-${i}`
        this.pending.push(id)
        blocks.push({ type: 'tool_use', id, name: mapped.name, input: mapped.input })
      })
      if (typeof line.content === 'string' && line.content.trim())
        blocks.push({ type: 'text', text: line.content })
      if (!calls.length && line.status === 'DONE') this.done = true
      return blocks.length ? [this.tagged('assistant', blocks)] : []
    }
    if (type === 'GENERIC') {
      const id = this.pending.shift()
      if (!id) return []
      const text = typeof line.content === 'string' ? line.content : ''
      const failed = line.status === 'ERROR' || /Command exited with code (?!0\b)\d+/.test(text)
      return [
        this.tagged('user', [
          { type: 'tool_result', tool_use_id: id, content: tidy(text), is_error: failed }
        ])
      ]
    }
    return []
  }

  private tagged(role: 'assistant' | 'user', content: Json[]): StreamJsonEvent {
    return { type: role, parent_tool_use_id: this.parent, message: { role, content } }
  }
}

/** `{"CommandLine": "\"ls\""}` → `{CommandLine: "ls"}`; a value that is not JSON stays as it is. */
export function decodeArgs(args: unknown): Json {
  if (!args || typeof args !== 'object') return {}
  const out: Json = {}
  for (const [k, v] of Object.entries(args as Json)) {
    if (typeof v !== 'string') {
      out[k] = v
      continue
    }
    try {
      out[k] = JSON.parse(v)
    } catch {
      out[k] = v
    }
  }
  return out
}

/** Drop the timestamps agy puts in front of every result. */
function tidy(text: string): string {
  return text
    .split('\n')
    .filter((l) => !/^(Created|Completed) At: /.test(l))
    .join('\n')
    .trim()
    .slice(0, 2000)
}

/**
 * Follow a sub-agent's transcripts until every one says it is done (or the
 * session ends, or it has run for half a day). Reads only what was appended
 * since the last look.
 */
export function followSubagent(
  child: { toolUseId: string; logs: string[] },
  emit: (event: StreamJsonEvent) => void,
  opts: { everyMs?: number; maxMs?: number } = {}
): () => void {
  const every = opts.everyMs ?? 1000
  const maxMs = opts.maxMs ?? 12 * 60 * 60 * 1000
  const started = Date.now()
  const files = child.logs.map((path, n) => ({
    path,
    offset: 0,
    partial: '',
    reader: new ChildTranscript(child.toolUseId, `${child.toolUseId}-c${n}`)
  }))
  let stopped = false
  const finish = (): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    emit({ type: 'system', subtype: 'task_notification', tool_use_id: child.toolUseId })
  }
  const look = (): void => {
    if (stopped) return
    for (const f of files) {
      let size = 0
      try {
        size = statSync(f.path).size
      } catch {
        continue // not written yet
      }
      if (size <= f.offset) continue
      const buf = Buffer.alloc(size - f.offset)
      let fd: number | null = null
      try {
        fd = openSync(f.path, 'r')
        readSync(fd, buf, 0, buf.length, f.offset)
      } catch {
        continue
      } finally {
        if (fd !== null) closeSync(fd)
      }
      f.offset = size
      const text = f.partial + buf.toString('utf8')
      const lines = text.split('\n')
      f.partial = lines.pop() ?? ''
      for (const raw of lines) {
        if (!raw.trim()) continue
        let line: Json
        try {
          line = JSON.parse(raw) as Json
        } catch {
          continue
        }
        for (const event of f.reader.feed(line)) emit(event)
      }
    }
    if (files.every((f) => f.reader.done) || Date.now() - started > maxMs) finish()
  }
  const timer = setInterval(look, every)
  look()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
