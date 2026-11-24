/**
 * Each agent's own thread of one chat, kept while another agent has the chat,
 * so switching back resumes it and only what it missed is sent (store.ts keeps
 * this as JSON in `chats.agentSessions`).
 */
export interface AgentSessions {
  kept?: Partial<Record<string, { id: string; items: number }>>
  /** Where the agent switched back to was: what it missed starts here. */
  catchUpFrom?: number
  /** Its session, to resume at the next start (once): the window may not know it. */
  resumeNext?: string
}

/**
 * The chat moves from agent `from` (its session `current`, the conversation
 * `items` long) to agent `to`. Returns the new record and the session `to`
 * gets back, null when it never ran this chat.
 */
export function swapSessions(
  v: AgentSessions,
  from: string | null,
  to: string,
  current: string | null,
  items: number
): { next: AgentSessions; back: string | null } {
  const next: AgentSessions = { ...v, kept: { ...(v.kept ?? {}) } }
  const kept = next.kept!
  if (from && from !== to && current) kept[from] = { id: current, items }
  const back = from !== to ? kept[to] : undefined
  if (back) {
    delete kept[to]
    next.catchUpFrom = back.items
    next.resumeNext = back.id
  } else {
    delete next.catchUpFrom
    delete next.resumeNext
  }
  return { next, back: back?.id ?? null }
}
