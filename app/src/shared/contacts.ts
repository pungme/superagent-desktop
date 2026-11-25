/**
 * Contacts: the people a project is reaching out to — funders, venues, partners —
 * with where each one stands. A small CRM: a table, not a sales pipeline.
 *
 * Kept per project (main/contacts.ts), read and updated by you on the Contacts
 * tab and by the agent through its contacts_* tools. Shared between main and
 * renderer, so no Electron or Node imports.
 */

export const CONTACT_STATUSES = ['not_sent', 'sent', 'replied', 'yes', 'no'] as const
export type ContactStatus = (typeof CONTACT_STATUSES)[number]

export const STATUS_LABEL: Record<ContactStatus, string> = {
  not_sent: 'Not sent',
  sent: 'Waiting',
  replied: 'Replied',
  yes: 'Yes',
  no: 'No'
}

export interface ContactEvent {
  at: number
  text: string
  by: 'you' | 'agent' | 'mail'
}

export interface Contact {
  id: string
  workspaceId: string
  name: string
  /** Organisation, role or how you know them: one line. */
  org: string
  email: string
  /** Phone, WhatsApp, "in person": how else to reach them. */
  channel: string
  /** What you are asking them for. */
  ask: string
  status: ContactStatus
  /** When you last reached out or heard back (ms), or null. */
  lastContactAt: number | null
  /** The day to follow up, YYYY-MM-DD, or ''. */
  followUp: string
  notes: string
  /** The project's own fields (budget, country…) by field key. */
  fields: Record<string, string>
  history: ContactEvent[]
  createdAt: number
  updatedAt: number
}

/**
 * A field this project's contacts have beyond the built-in ones. Anyone can
 * add one — the agent when you ask it to track "budget" or "country", or you
 * on a contact — and it appears on every contact of the project.
 */
export interface FieldDef {
  key: string
  label: string
  /** A hint for how to show and sort it. */
  type: 'text' | 'number' | 'date' | 'url'
}

/** Fields a project may define, and the longest a value may be. */
export const FIELDS_MAX = 24
export const FIELD_VALUE_MAX = 500

/** A label as a stable key: "Budget (€)" → "budget". Never empty, never a built-in. */
export function fieldKey(label: string): string {
  const k = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40)
  return k && !BUILT_IN.has(k) ? k : k ? `${k}_2` : ''
}

const BUILT_IN = new Set([
  'name',
  'org',
  'email',
  'channel',
  'ask',
  'status',
  'follow_up',
  'followup',
  'notes',
  'id'
])

/** What kind of value a field holds, from what was put in it. */
export function guessFieldType(value: string): FieldDef['type'] {
  const v = value.trim()
  if (/^https?:\/\//i.test(v)) return 'url'
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return 'date'
  if (/^[€$£]?\s?-?\d[\d.,\s]*\s?(k|m|€|eur|usd)?$/i.test(v)) return 'number'
  return 'text'
}

/** How long after reaching out a follow-up falls due, when none was set. */
export const FOLLOW_UP_DAYS = 7

/** "in progress", "waiting", "✓", "declined"… → a status, or null for nonsense. */
export function toStatus(raw: unknown): ContactStatus | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if ((CONTACT_STATUSES as readonly string[]).includes(s)) return s as ContactStatus
  if (/^(new|todo|to_do|not_contacted|draft|☐|□)$/.test(s)) return 'not_sent'
  if (/^(waiting|contacted|emailed|messaged|pending|follow_up|followup|✉)$/.test(s)) return 'sent'
  if (/^(answered|responded|reply|in_talks|talking)$/.test(s)) return 'replied'
  if (/^(accepted|won|agreed|confirmed|✓|✔)$/.test(s)) return 'yes'
  if (/^(declined|rejected|lost|refused|✗|✕|×)$/.test(s)) return 'no'
  return null
}

const pad = (n: number): string => String(n).padStart(2, '0')
/** A date as YYYY-MM-DD in local time. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The day `days` after `from`, as YYYY-MM-DD. */
export function addDays(from: number, days: number): string {
  const d = new Date(from)
  d.setDate(d.getDate() + days)
  return ymd(d)
}

/** "2026-12-01" → itself; "1 Dec 2026", "12/01/2026"… → YYYY-MM-DD; '' when it is not a date. */
export function toDay(raw: unknown): string {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const t = Date.parse(s)
  return Number.isNaN(t) ? '' : ymd(new Date(t))
}

/** Waiting on someone and the follow-up day has come. Only for those still open. */
export function isDue(c: Pick<Contact, 'status' | 'followUp'>, today: string): boolean {
  return (c.status === 'sent' || c.status === 'not_sent') && !!c.followUp && c.followUp <= today
}

export type ContactFilter = 'all' | 'due' | ContactStatus

export function matches(c: Contact, filter: ContactFilter, today: string, query = ''): boolean {
  if (filter === 'due' && !isDue(c, today)) return false
  if (filter !== 'all' && filter !== 'due' && c.status !== filter) return false
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [c.name, c.org, c.email, c.channel, c.ask, c.notes, ...Object.values(c.fields ?? {})].some(
    (f) => f.toLowerCase().includes(q)
  )
}

/** Due first (oldest follow-up first), then replied, waiting, not sent, yes, no; by name within. */
export function sortContacts(list: Contact[], today: string): Contact[] {
  const rank = (c: Contact): number =>
    isDue(c, today)
      ? 0
      : ({ replied: 1, sent: 2, not_sent: 3, yes: 4, no: 5 } as Record<ContactStatus, number>)[
          c.status
        ]
  return [...list].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 0 ? a.followUp.localeCompare(b.followUp) : 0) ||
      a.name.localeCompare(b.name)
  )
}

export function summarize(
  list: Contact[],
  today: string
): Record<ContactStatus | 'due' | 'all', number> {
  const out = { all: list.length, due: 0, not_sent: 0, sent: 0, replied: 0, yes: 0, no: 0 }
  for (const c of list) {
    out[c.status]++
    if (isDue(c, today)) out.due++
  }
  return out
}

/**
 * What changes when an email goes to this contact: they are waiting on, last
 * contacted now, and a follow-up a week out unless one is already set later.
 * A contact who already said yes or no keeps that answer.
 */
export function afterEmail(
  c: Contact,
  now: number,
  subject: string
): Pick<Contact, 'status' | 'lastContactAt' | 'followUp'> & { event: ContactEvent } {
  const settled = c.status === 'yes' || c.status === 'no'
  const due = addDays(now, FOLLOW_UP_DAYS)
  return {
    status: settled ? c.status : c.status === 'replied' ? 'replied' : 'sent',
    lastContactAt: now,
    followUp: settled
      ? c.followUp
      : c.followUp && c.followUp > ymd(new Date(now))
        ? c.followUp
        : due,
    event: { at: now, by: 'mail', text: subject ? `Email sent: ${subject}` : 'Email sent' }
  }
}

/** Addresses in a To/Cc field ("Ann <ann@x.org>, bob@y.com") → lower-case addresses. */
export function addresses(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw.map(String) : [String(raw ?? '')]
  const out: string[] = []
  for (const part of list)
    for (const m of part.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi))
      out.push(m[0].toLowerCase())
  return out
}

/** "Anna Lee anna@x.org" → a name and an email, whichever were given. */
export function quickContact(text: string): { name: string; email: string } {
  const email = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.exec(text)?.[0] ?? ''
  const name = text
    .replace(email, '')
    .replace(/[<>(),;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return { name: name || email.split('@')[0] || '', email: email.toLowerCase() }
}
