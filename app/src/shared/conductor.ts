/**
 * Conductor: a project's Main chat that you keep writing to, while Superagent starts, routes to,
 * inspects and closes worker sessions behind it. Pure helpers shared by main and the renderer;
 * the plan is in .superagent/cto-mode/plan.md.
 */

export type ConductorRouting = 'confirm' | 'auto'

export interface ConductorSession {
  chatId: string
  title: string
  /** The per-project number: 101, 102… Kept when a session is disconnected and connected again. */
  ticket: number | null
  /** One or two lines on where it stands, written when the worker finishes or pauses. */
  summary: string
  status: 'working' | 'needs-you' | 'idle' | 'closed'
  /** Last used (ms). */
  updatedAt: number
  /** What it is waiting to be allowed to do (an open approval), when status is needs-you. */
  approval?: { requestId: string; preview: string }
  branch?: string
  /** Commits on its branch not yet in the project's main branch. */
  unmerged?: number
}

export const FIRST_TICKET = 101

export function ticketLabel(n: number): string {
  return `#${n}`
}

/** "#101", "101", "ticket 101", "session #101" → 101; null for anything else. */
export function parseTicketRef(text: string): number | null {
  const m = /^\s*(?:(?:ticket|session|worker)\s+)?#?(\d{1,6})\s*$/i.exec(text)
  return m ? Number(m[1]) : null
}

/** A short title from the first words of a task: no trailing stop, at most `max` characters. */
export function autoTitle(task: string, max = 48): string {
  const first = task
    .trim()
    .split(/\n/)[0]
    .replace(/\s+/g, ' ')
    .replace(/[.!?:;,\s]+$/, '')
  if (first.length <= max) return first
  const cut = first.slice(0, max).replace(/\s+\S*$/, '')
  return (cut || first.slice(0, max)).replace(/[.!?:;,\s]+$/, '') + '…'
}

const STATUS_WORD: Record<ConductorSession['status'], string> = {
  working: 'Working',
  'needs-you': 'Needs you',
  idle: 'Idle',
  closed: 'Closed'
}

/**
 * The compact picture of a project's sessions that goes in front of the Conductor on every turn:
 * small on purpose (a line per session), so Main stays light however much the workers read.
 */
export function buildManifest(input: {
  project: string
  routing: ConductorRouting
  sessions: ConductorSession[]
  unlinked: { chatId: string; title: string }[]
}): string {
  const live = input.sessions.filter((s) => s.status !== 'closed')
  const closed = input.sessions.length - live.length
  const lines = [
    `Project: ${input.project}. Routing: ${input.routing === 'auto' ? 'Auto' : 'Confirm'}.`,
    live.length ? 'Sessions:' : 'No sessions yet.'
  ]
  for (const s of live) {
    const bits = [
      s.ticket != null ? ticketLabel(s.ticket) : '—',
      s.title || 'Untitled',
      STATUS_WORD[s.status],
      s.branch ? `branch ${s.branch}${s.unmerged ? ` (${s.unmerged} unmerged)` : ''}` : '',
      s.summary
    ].filter(Boolean)
    lines.push(`- ${bits.join(' · ')}`)
  }
  if (closed)
    lines.push(`${closed} closed (conductor_list_sessions with includeClosed shows them).`)
  if (input.unlinked.length)
    lines.push(
      `Chats not connected to Main: ${input.unlinked
        .slice(0, 8)
        .map((c) => c.title || 'Untitled')
        .join('; ')}${input.unlinked.length > 8 ? ` and ${input.unlinked.length - 8} more` : ''}.`
    )
  return lines.join('\n')
}

/** What the Conductor is told about its job. The manifest follows it. */
export function conductorPrompt(routing: ConductorRouting): string {
  const how =
    routing === 'auto'
      ? 'Routing is Auto: a clear new task starts a session at once, a clear follow-up goes to the ' +
        'session it belongs to at once, and when you are not sure which session or project a ' +
        'message belongs to, ask with an ```ask block of choices.'
      : 'Routing is Confirm: for a question or a new task, talk it over first and ask before ' +
        'starting a session (the person answers "yes" or picks an ```ask choice); a clear follow-up ' +
        'to an existing session may go straight to it and you say so.'
  return (
    'You are the Conductor of this project: its Main chat. The person keeps writing to you and ' +
    'you decide where each message goes. Do not do heavy work here (reading many files, long ' +
    'edits, builds, long investigations): start a worker session for it with conductor_spawn_session, ' +
    'and send follow-ups to it with conductor_send_to_session, so this conversation stays light. ' +
    'Answer questions about status, architecture and plans yourself, from the session list below ' +
    'and from conductor_inspect_session when you need more. Every session has a number (#101…) ' +
    'and a short title you give it; say the number when you mention one. ' +
    'The session list that follows is as it was when this conversation began: call ' +
    'conductor_list_sessions for the current one before you route a message or answer about status. ' +
    'Before closing a session with unmerged commits, offer: merge into main and close, close and ' +
    'keep the branch, or discard and close (only if the person asks for that). ' +
    how
  )
}
