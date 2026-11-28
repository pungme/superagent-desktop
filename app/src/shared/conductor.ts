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
  /** Files it has changed against the main branch (commits and uncommitted work). */
  files?: string[]
  /** Messages in its conversation (the person's and the agent's). */
  messages?: number
}

/** Pairs of live sessions that both changed the same files: where their work will collide. */
export function overlaps(
  sessions: ConductorSession[]
): { a: ConductorSession; b: ConductorSession; files: string[] }[] {
  const live = sessions.filter((s) => s.status !== 'closed' && s.files?.length)
  const out: { a: ConductorSession; b: ConductorSession; files: string[] }[] = []
  for (let i = 0; i < live.length; i++)
    for (let j = i + 1; j < live.length; j++) {
      const other = new Set(live[j].files)
      const files = live[i].files!.filter((f) => other.has(f))
      if (files.length) out.push({ a: live[i], b: live[j], files })
    }
  return out
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

/**
 * The tracker's ticket id in a session title ("WD-284 Fix header wrap" -> "WD-284"), when the
 * person named one or Main knew the ticket. Sessions have an internal number (#101) that Main
 * uses in its tools; what people see is this key, or just the title when there is none.
 */
export function trackerKey(title: string): string | null {
  const m = /^\s*([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/.exec(title)
  return m ? m[1] : null
}

/** The title without its leading tracker key ("WD-284 Fix header wrap" -> "Fix header wrap"). */
export function titleWithoutKey(title: string): string {
  const k = trackerKey(title)
  return k ? title.replace(/^\s*[A-Z][A-Z0-9]{1,9}-\d{1,6}[\s:–-]*/, '') || title : title
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
      s.files?.length
        ? `touches ${s.files.slice(0, 4).join(', ')}${s.files.length > 4 ? ` +${s.files.length - 4} more` : ''}`
        : '',
      s.summary
    ].filter(Boolean)
    lines.push(`- ${bits.join(' · ')}`)
  }
  for (const o of overlaps(input.sessions))
    lines.push(
      `Overlap: ${ticketLabel(o.a.ticket ?? 0)} and ${ticketLabel(o.b.ticket ?? 0)} both change ${o.files.slice(0, 3).join(', ')}${o.files.length > 3 ? ` +${o.files.length - 3} more` : ''}.`
    )
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
    'and a short title you give it: three to six words, a noun phrase for the work ("Pricing page redesign"), ' +
    'never the whole request. When the person names a ticket from their tracker, or you can tell which ticket ' +
    'the work belongs to from what you know of their tracker, put its id in front ("WD-284 Fix header wrap"); ' +
    'otherwise give it no number at all. The numbers (#101) are only handles for your tools: tell the person ' +
    'about a session by its ticket id or its title, never by that number. ' +
    'Every message to you starts with a [Conductor state] block that Superagent adds (the person did ' +
    "not write it): the sessions as they are now, the project's git state, its open to-dos and the " +
    'index of your saved memory. Trust the newest one over anything earlier in this conversation. ' +
    'Memory: this conversation gets compacted and restarted, so what must last goes into your saved ' +
    'memory with conductor_remember: decisions the person made, their preferences, facts about the ' +
    'project, data structures and schemas (field names and where they live), plans, and what a session ' +
    'found out. Use one clear key per thing and update it rather than adding near-copies; remove what ' +
    'is no longer true with conductor_forget. Before you answer about something decided or built ' +
    'earlier, check the index and conductor_recall it rather than guessing. ' +
    'Sessions work side by side, so keep them from colliding: before you start a session or send ' +
    'a message, compare it with what the working sessions touch (the list shows the files). If it ' +
    'would change the same files or the same feature as one that is still working, do not start a ' +
    'parallel one: ask whether to add it to that session or wait until it is done (in Auto too). ' +
    'Independent work gets its own session. When the list shows an Overlap, merge those sessions ' +
    'one at a time and tell the person about the likely conflict. ' +
    'Before closing a session with unmerged commits, offer the three ways as an ```ask block of ' +
    'choices: "Merge into main & close", "Close & keep branch", "Discard changes & close" (discard ' +
    'only if the person picks it). ' +
    'When a session finishes work the person has seen or approved (its list entry shows unmerged ' +
    'commits and it is idle), offer to merge it into main: conductor_merge_session lands the commits ' +
    'and keeps the session open, conductor_close_session with how "merge" lands and closes. Merge only ' +
    'after the person says yes (or said earlier to merge when done); never merge a session that is ' +
    'still working or waiting on the person. ' +
    how
  )
}
