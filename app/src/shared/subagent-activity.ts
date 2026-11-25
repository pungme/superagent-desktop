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
  kind: 'tool' | 'text'
  /** Tool name, or '' for text. */
  name: string
  /** The command, file or query for a tool; the words for text. */
  detail: string
  at: number
  /** Tools only: came back, and whether it worked. */
  done?: boolean
  ok?: boolean
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
        l.push({
          id: b.id,
          kind: 'tool',
          name: String(b.name ?? ''),
          detail: stepDetail(b.input),
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
