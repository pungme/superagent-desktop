/**
 * What a sub-agent is doing, from the events the CLI streams for it.
 *
 * Messages a sub-agent produces arrive in the main stream tagged with
 * `parent_tool_use_id` = the id of the tool call that started it. They are
 * folded here into a short list of steps (tool calls with whether they came
 * back, and what it said), so the "Running in background" pill can open onto
 * them. Pure: the chat keeps the map and calls `noteSubagentEvent` per event.
 */

export interface SubStep {
  /** The tool call's id, for a text line a made-up one. */
  id: string
  kind: 'tool' | 'text' | 'thinking'
  /** Tool name, or '' for text. */
  name: string
  /** The command, file or query for a tool; the words for text. */
  detail: string
  at: number
  /** Tools only: came back, and whether it worked. */
  done?: boolean
  ok?: boolean
  /** A TodoWrite call: its list as the sub-agent last wrote it. */
  todos?: { text: string; status: string }[]
}

export type SubActivity = Map<string, SubStep[]>

/** Steps kept per sub-agent, and sub-agents kept. */
export const STEPS_KEPT = 40
export const AGENTS_KEPT = 24

type Block = Record<string, unknown>

/** The command, file or query a tool call is about, in a line. */
export function stepDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick = o.command ?? o.query ?? o.url ?? o.pattern ?? o.prompt ?? o.description ?? o.text
  if (typeof pick === 'string') return pick.replace(/\s+/g, ' ').trim().slice(0, 160)
  if (typeof o.file_path === 'string') return o.file_path
  if (typeof o.path === 'string') return o.path
  return ''
}

/**
 * Fold one stream event in. Returns true when it belonged to a sub-agent (and
 * changed something). `now` is passed in so a test is deterministic.
 */
export function noteSubagentEvent(
  activity: SubActivity,
  event: Record<string, unknown>,
  now: number
): boolean {
  const parent = event.parent_tool_use_id
  if (typeof parent !== 'string' || !parent) return false
  const message = event.message as { content?: unknown } | undefined
  const content = Array.isArray(message?.content) ? (message!.content as Block[]) : []
  let steps = activity.get(parent)
  let changed = false
  const list = (): SubStep[] => {
    if (!steps) {
      steps = []
      activity.set(parent, steps)
      // Forget the oldest sub-agent beyond the cap.
      while (activity.size > AGENTS_KEPT) activity.delete(activity.keys().next().value as string)
    }
    return steps
  }
  if (event.type === 'assistant') {
    for (const b of content) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        const l = list()
        if (l.some((s) => s.id === b.id)) continue
        const todos = b.name === 'TodoWrite' ? todosOf(b.input) : undefined
        l.push({
          id: b.id,
          kind: 'tool',
          name: String(b.name ?? ''),
          detail: todos
            ? `${todos.filter((t) => t.status === 'completed').length}/${todos.length} tasks`
            : stepDetail(b.input),
          at: now,
          ...(todos ? { todos } : {})
        })
        changed = true
      } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
        const l = list()
        // Thinking streams as it is written: the last line says what it is on, so
        // a run of them is one line, not a page.
        const last = l[l.length - 1]
        const text = b.thinking.replace(/\s+/g, ' ').trim().slice(-300)
        if (last?.kind === 'thinking') {
          last.detail = text
          last.at = now
        } else
          l.push({
            id: `think-${now}-${l.length}`,
            kind: 'thinking',
            name: '',
            detail: text,
            at: now
          })
        changed = true
      } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        list().push({
          id: `text-${now}-${list().length}`,
          kind: 'text',
          name: '',
          detail: b.text.replace(/\s+/g, ' ').trim().slice(0, 300),
          at: now
        })
        changed = true
      }
    }
  } else if (event.type === 'user') {
    for (const b of content) {
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue
      const step = steps?.find((s) => s.id === b.tool_use_id)
      if (step) {
        step.done = true
        step.ok = b.is_error !== true
        changed = true
      }
    }
  }
  if (steps && steps.length > STEPS_KEPT) steps.splice(0, steps.length - STEPS_KEPT)
  return changed
}

/** The one line for the pill's tooltip: what it is doing right now. */
export function currentStep(steps: SubStep[] | undefined): SubStep | null {
  if (!steps?.length) return null
  for (let i = steps.length - 1; i >= 0; i--)
    if (steps[i].kind === 'tool' && !steps[i].done) return steps[i]
  return steps[steps.length - 1]
}

/** A TodoWrite input as a list, or undefined when it is not one. */
export function todosOf(input: unknown): { text: string; status: string }[] | undefined {
  const list = (input as { todos?: unknown } | null)?.todos
  if (!Array.isArray(list)) return undefined
  const out = list
    .map((t) => {
      const o = t as { content?: unknown; activeForm?: unknown; status?: unknown }
      const text =
        typeof o.content === 'string'
          ? o.content
          : typeof o.activeForm === 'string'
            ? o.activeForm
            : ''
      return { text, status: typeof o.status === 'string' ? o.status : 'pending' }
    })
    .filter((t) => t.text)
  return out.length ? out : undefined
}

/**
 * How far along it is: its own to-do list when it keeps one (the latest list it
 * wrote), else nothing to measure, only a count of calls.
 */
export function progressOf(steps: SubStep[] | undefined): {
  tasks: { done: number; total: number; now: string | null } | null
  calls: number
  waiting: number
} {
  const all = steps ?? []
  let tasks: { done: number; total: number; now: string | null } | null = null
  for (let i = all.length - 1; i >= 0; i--) {
    const todos = all[i].todos
    if (!todos) continue
    tasks = {
      done: todos.filter((t) => t.status === 'completed').length,
      total: todos.length,
      now: todos.find((t) => t.status === 'in_progress')?.text ?? null
    }
    break
  }
  const calls = all.filter((s) => s.kind === 'tool')
  return { tasks, calls: calls.length, waiting: calls.filter((s) => !s.done).length }
}
