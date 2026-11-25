/**
 * Each agent's own thread of one chat, kept while another agent has the chat,
 * so switching back resumes it and only what it missed is sent (store.ts keeps
 * this as JSON in `chats.agentSessions`).
 */
export interface AgentSessions {
  /** `id` is '' for an agent that never started a thread (only its model pick was kept). */
  kept?: Partial<Record<string, { id: string; items: number; model?: string }>>
  /** Where the agent switched back to was: what it missed starts here. */
  catchUpFrom?: number
  /** Its session, to resume at the next start (once): the window may not know it. */
  resumeNext?: string
}

/**
 * The chat moves from agent `from` (its session `current`, the conversation
 * `items` long, the model picked `model`) to agent `to`. Returns the new record,
 * the session `to` gets back (null when it never ran this chat) and the model it
 * had picked then (null: its own default).
 */
export function swapSessions(
  v: AgentSessions,
  from: string | null,
  to: string,
  current: string | null,
  items: number,
  model: string | null = null
): { next: AgentSessions; back: string | null; model: string | null } {
  const next: AgentSessions = { ...v, kept: { ...(v.kept ?? {}) } }
  const kept = next.kept!
  if (from && from !== to && (current || model))
    kept[from] = { id: current ?? '', items, ...(model ? { model } : {}) }
  const prior = from !== to ? kept[to] : undefined
  if (prior) delete kept[to]
  const back = prior?.id || null
  if (back) {
    next.catchUpFrom = prior!.items
    next.resumeNext = back
  } else {
    delete next.catchUpFrom
    delete next.resumeNext
  }
  return { next, back, model: prior?.model ?? null }
}
