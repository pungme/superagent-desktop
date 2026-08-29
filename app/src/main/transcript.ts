import type { DiffHunk, WireEventData } from '../shared/companion-protocol'

/**
 * Turns Claude Code's stream-json into the companion's event vocabulary.
 *
 * The renderer has its own projection of the same stream (EasyChat's
 * handleEvent) tuned for the UI; this one is the stable wire format the phone
 * subscribes to. Pure and Electron-free so it can be tested from captures.
 *
 * One instance per agent session — it remembers which blocks it has already
 * emitted, because the CLI can re-send an `assistant` message as it grows.
 */

export interface Projection {
  /** Sequenced, persisted. */
  persist: WireEventData[]
  /** Streaming text that is never stored; the phone renders it transiently. */
  delta?: string
}

const NO_OUTPUT: Projection = { persist: [] }

export class TranscriptProjector {
  private emitted = new Set<string>()
  /** Text streamed so far for the block the CLI is currently writing. */
  private streamed = ''

  project(raw: Record<string, unknown>): Projection {
    const type = raw.type as string
    if (type === 'system' && raw.subtype === 'init') {
      const sid = raw.session_id as string | undefined
      if (!sid) return NO_OUTPUT
      return {
        persist: [{ kind: 'session', claudeSessionId: sid, model: raw.model as string | undefined }]
      }
    }
    if (type === 'stream_event') {
      const ev = raw.event as Record<string, unknown> | undefined
      if (ev?.type === 'content_block_start') this.streamed = ''
      if (ev?.type === 'content_block_delta') {
        const delta = ev.delta as Record<string, unknown> | undefined
        if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
          this.streamed += delta.text
          return { persist: [], delta: delta.text }
        }
      }
      return NO_OUTPUT
    }
    if (type === 'assistant') return this.assistant(raw)
    if (type === 'user') return this.toolResults(raw)
    if (type === 'result') {
      const usage = raw.usage as Record<string, number> | undefined
      const tokens = usage
        ? (usage.input_tokens ?? 0) +
          (usage.cache_read_input_tokens ?? 0) +
          (usage.cache_creation_input_tokens ?? 0) +
          (usage.output_tokens ?? 0)
        : undefined
      this.streamed = ''
      return {
        persist: [
          {
            kind: 'turn_end',
            ok: raw.is_error !== true,
            subtype: typeof raw.subtype === 'string' ? raw.subtype : 'success',
            ...(typeof raw.total_cost_usd === 'number' ? { costUsd: raw.total_cost_usd } : {}),
            ...(tokens ? { tokens } : {})
          }
        ]
      }
    }
    return NO_OUTPUT
  }

  private assistant(raw: Record<string, unknown>): Projection {
    const msg = raw.message as Record<string, unknown> | undefined
    const content = (msg?.content as Record<string, unknown>[] | undefined) ?? []
    const msgId = (msg?.id as string | undefined) ?? `m-${Date.now()}`
    const isApiError = msg?.isApiErrorMessage === true
    const out: WireEventData[] = []
    content.forEach((block, i) => {
      const key = `${msgId}:${i}:${block.type}`
      if (block.type === 'text') {
        const text = typeof block.text === 'string' ? block.text : ''
        if (!text.trim() || this.emitted.has(key)) return
        this.emitted.add(key)
        out.push(
          isApiError ? { kind: 'notice', text } : { kind: 'assistant', id: `${msgId}-${i}`, text }
        )
      } else if (block.type === 'thinking') {
        const text = typeof block.thinking === 'string' ? block.thinking : ''
        if (!text.trim() || this.emitted.has(key)) return
        this.emitted.add(key)
        out.push({ kind: 'thinking', id: `${msgId}-${i}`, text })
      } else if (block.type === 'tool_use') {
        const id = typeof block.id === 'string' ? block.id : `${msgId}-${i}`
        if (this.emitted.has(id)) return
        this.emitted.add(id)
        const name = typeof block.name === 'string' ? block.name : 'tool'
        const diff = toolDiff(name, id, block.input)
        out.push(diff ?? { kind: 'tool', id, name, detail: toolDetail(block.input) })
      }
    })
    if (out.length) this.streamed = ''
    return { persist: out }
  }

  private toolResults(raw: Record<string, unknown>): Projection {
    const content = (raw.message as { content?: unknown } | undefined)?.content
    if (!Array.isArray(content)) return NO_OUTPUT
    const out: WireEventData[] = []
    for (const block of content as Record<string, unknown>[]) {
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const key = `r:${block.tool_use_id}`
      if (this.emitted.has(key)) continue
      this.emitted.add(key)
      out.push({
        kind: 'tool_result',
        toolId: block.tool_use_id,
        ok: block.is_error !== true,
        summary: resultText(block.content).slice(0, 400)
      })
    }
    return { persist: out }
  }
}

function resultText(c: unknown): string {
  if (typeof c === 'string') return c
  if (Array.isArray(c))
    return (c as Record<string, unknown>[])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('\n')
  return ''
}

/** The one-line "what this tool does" — same rule the desktop transcript uses. */
export function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick = o.query ?? o.url ?? o.pattern ?? o.command ?? o.prompt ?? o.description ?? o.text
  if (typeof pick === 'string') return pick.replace(/\s+/g, ' ').trim().slice(0, 70)
  if (typeof o.file_path === 'string') return o.file_path.split('/').pop() ?? ''
  return ''
}

function trimCommon(removed: string[], added: string[]): DiffHunk {
  let start = 0
  while (start < removed.length && start < added.length && removed[start] === added[start]) start++
  let endR = removed.length
  let endA = added.length
  while (endR > start && endA > start && removed[endR - 1] === added[endA - 1]) {
    endR--
    endA--
  }
  return { removed: removed.slice(start, endR), added: added.slice(start, endA) }
}

/** A diff card from an Edit/Write/MultiEdit input; null for any other tool. */
export function toolDiff(
  name: string,
  id: string,
  input: unknown
): Extract<WireEventData, { kind: 'diff' }> | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const file = typeof o.file_path === 'string' ? (o.file_path.split('/').pop() ?? '') : ''
  const lines = (s: unknown): string[] =>
    typeof s === 'string' && s ? s.replace(/\n$/, '').split('\n') : []
  if (name === 'Edit' && (o.old_string || o.new_string)) {
    return { kind: 'diff', id, file, hunks: [trimCommon(lines(o.old_string), lines(o.new_string))] }
  }
  if (name === 'Write' && o.content) {
    return { kind: 'diff', id, file, hunks: [{ removed: [], added: lines(o.content) }] }
  }
  if (name === 'MultiEdit' && Array.isArray(o.edits)) {
    const hunks = (o.edits as Record<string, unknown>[]).map((e) =>
      trimCommon(lines(e.old_string), lines(e.new_string))
    )
    return { kind: 'diff', id, file, hunks }
  }
  return null
}

// --- Legacy transcripts -----------------------------------------------------

/** The renderer's saved transcript shape (chats.data). Only what we read. */
export type LegacyItem =
  | {
      kind: 'msg'
      msg: {
        id: string
        role: 'user' | 'assistant'
        text: string
        system?: boolean
        images?: string[]
      }
    }
  | { kind: 'tool'; tool: { id: string; name: string; detail: string } }
  | { kind: 'diff'; diff: { id: string; file: string; hunks: DiffHunk[] } }
  | { kind: 'thinking'; id: string; text: string }

/**
 * Chats that predate the event log: project the saved transcript once so the
 * phone can show them. Lossy by design (no tool results, no turn ends).
 */
export function projectLegacyItems(items: LegacyItem[]): WireEventData[] {
  const out: WireEventData[] = []
  for (const it of items) {
    if (!it || typeof it !== 'object') continue
    if (it.kind === 'msg' && it.msg) {
      if (it.msg.system) out.push({ kind: 'notice', text: it.msg.text ?? '' })
      else if (it.msg.role === 'user')
        out.push({
          kind: 'user',
          id: it.msg.id,
          text: it.msg.text ?? '',
          from: 'desktop',
          ...(it.msg.images?.length
            ? { images: it.msg.images.map((u) => ({ mediaType: dataUrlType(u), size: u.length })) }
            : {})
        })
      else out.push({ kind: 'assistant', id: it.msg.id, text: it.msg.text ?? '' })
    } else if (it.kind === 'tool' && it.tool) {
      out.push({ kind: 'tool', id: it.tool.id, name: it.tool.name, detail: it.tool.detail ?? '' })
    } else if (it.kind === 'diff' && it.diff) {
      out.push({ kind: 'diff', id: it.diff.id, file: it.diff.file, hunks: it.diff.hunks ?? [] })
    } else if (it.kind === 'thinking') {
      out.push({ kind: 'thinking', id: it.id, text: it.text ?? '' })
    }
  }
  return out
}

function dataUrlType(u: string): string {
  const m = /^data:([^;,]+)/.exec(u)
  return m ? m[1] : 'image/png'
}

/**
 * The reverse: wire events → the renderer's Item[] shape, so a turn that ran
 * while no window was open still shows up in the desktop transcript.
 */
export function toLegacyItems(events: WireEventData[]): LegacyItem[] {
  const out: LegacyItem[] = []
  for (const e of events) {
    if (e.kind === 'user') out.push({ kind: 'msg', msg: { id: e.id, role: 'user', text: e.text } })
    else if (e.kind === 'assistant')
      out.push({ kind: 'msg', msg: { id: e.id, role: 'assistant', text: e.text } })
    else if (e.kind === 'notice')
      out.push({
        kind: 'msg',
        msg: {
          id: `sys-${Date.now()}-${out.length}`,
          role: 'assistant',
          text: e.text,
          system: true
        }
      })
    else if (e.kind === 'tool')
      out.push({ kind: 'tool', tool: { id: e.id, name: e.name, detail: e.detail } })
    else if (e.kind === 'diff')
      out.push({ kind: 'diff', diff: { id: e.id, file: e.file, hunks: e.hunks } })
    else if (e.kind === 'thinking') out.push({ kind: 'thinking', id: e.id, text: e.text })
  }
  return out
}
