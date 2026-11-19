/** What Today needs to rank to-dos and to tell an agent about the day. No Electron or Node here. */

export interface TodoLike {
  id: string
  workspaceId: string
  title: string
  status: 'todo' | 'doing' | 'testing' | 'done'
  updatedAt: number
}

/** How many to-dos Today lists before "Show all". */
export const TODAY_TODOS = 10

const rank = (s: TodoLike['status']): number => (s === 'doing' ? 0 : s === 'testing' ? 1 : 2)

/**
 * The to-dos worth looking at today, in order: what is being worked on, what is
 * being checked, then the ones touched most recently. A project can hold
 * hundreds of old cards; the list is not the place to read them all.
 */
export function rankTodos<T extends TodoLike>(cards: T[]): T[] {
  return [...cards].sort((a, b) => rank(a.status) - rank(b.status) || b.updatedAt - a.updatedAt)
}

export function pickTodos<T extends TodoLike>(
  cards: T[],
  all: boolean,
  limit = TODAY_TODOS
): { shown: T[]; hidden: number } {
  const ranked = rankTodos(cards)
  if (all) return { shown: ranked, hidden: 0 }
  // Everything in progress stays, even past the limit: that is the point of Today.
  const inProgress = ranked.filter((c) => c.status !== 'todo').length
  const n = Math.max(limit, Math.min(inProgress, 25))
  return { shown: ranked.slice(0, n), hidden: Math.max(0, ranked.length - n) }
}

export interface DayEvent {
  title: string
  /** YYYY-MM-DD (all day) or YYYY-MM-DDTHH:mm. */
  start: string
  end: string | null
  allDay: boolean
  notes: string
}

/**
 * The day as plain text for an agent to read (written to a file, not pasted into
 * the message): the calendar, then the to-dos by project, in-progress first.
 */
export function dayNotes(
  now: Date,
  events: DayEvent[],
  cards: TodoLike[],
  projectName: (workspaceId: string) => string,
  maxTodos = 250
): string {
  const part = (o: Intl.DateTimeFormatOptions): string => now.toLocaleDateString('en-GB', o)
  const day = `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'long' })} ${part({ year: 'numeric' })}`
  const time = now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  const lines: string[] = [`# Today: ${day}, it is ${time}`, '', '## Calendar']
  const timed = events.filter((e) => !e.allDay).sort((a, b) => a.start.localeCompare(b.start))
  const allDay = events.filter((e) => e.allDay)
  if (!events.length) lines.push('Nothing on the calendar today.')
  for (const e of allDay) lines.push(`- All day: ${e.title}`)
  for (const e of timed) {
    const range = `${e.start.slice(11, 16)}${e.end && e.end.length >= 16 ? `-${e.end.slice(11, 16)}` : ''}`
    lines.push(`- ${range} ${e.title}${e.notes ? ` (${e.notes.split('\n')[0].slice(0, 80)})` : ''}`)
  }
  const ranked = rankTodos(cards)
  lines.push('', `## To-dos (${ranked.length} open, in progress first)`)
  const byProject = new Map<string, TodoLike[]>()
  for (const c of ranked.slice(0, maxTodos)) {
    const list = byProject.get(c.workspaceId) ?? []
    list.push(c)
    byProject.set(c.workspaceId, list)
  }
  for (const [ws, list] of byProject) {
    lines.push('', `### ${projectName(ws)}`)
    for (const c of list) lines.push(`- ${c.status === 'todo' ? '' : `[${c.status}] `}${c.title}`)
  }
  if (ranked.length > maxTodos)
    lines.push('', `(${ranked.length - maxTodos} older to-dos not listed)`)
  return lines.join('\n') + '\n'
}

/**
 * What the Today box's assistant does with a request. Written at the top of its
 * notes file, so the message itself stays what the user typed.
 */
export const TODAY_ASSISTANT_RULES = `## How to handle a request from the Today box

You are my assistant for the day. The user's message is the request; this file is my calendar and to-dos.

- A question about my day: answer from this file.
- Work that belongs in a conversation that already exists: find it with app_find_chats (search the project name and the topic), look at app_status, and give it the work with app_send_message. Prefer a conversation that exists over a new one.
- If no conversation fits: app_new_chat in the right project (app_list_projects) with the work as its message.
- A to-do to add or tick off: app_board_add or app_board_move.
- Do not do the project work yourself here. Reply in one or two lines that say where it went.
`
