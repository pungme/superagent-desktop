import { ipcMain } from 'electron'
import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { getDb } from './store'
import { broadcastToWindows } from './util'
import {
  addresses,
  afterEmail,
  toDay,
  toStatus,
  type Contact,
  type ContactEvent,
  type ContactStatus
} from '../shared/contacts'

/**
 * A project's contacts (shared/contacts.ts): one table, written by the Contacts
 * tab, the agent's contacts_* tools and an email sent to one of them.
 */

let db: Database.Database | null = null
function conn(): Database.Database {
  if (db) return db
  db = getDb()
  return schema(db)
}

function schema(d: Database.Database): Database.Database {
  d.exec(`
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL,
      name TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      channel TEXT NOT NULL DEFAULT '',
      ask TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'not_sent',
      lastContactAt INTEGER,
      followUp TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      history TEXT NOT NULL DEFAULT '[]',
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS contacts_by_ws ON contacts (workspaceId);
  `)
  return d
}

/** Tests only: a database of the test's own. */
export function _useDbForTests(d: Database.Database): void {
  db = schema(d)
}

const HISTORY_KEPT = 50

interface Row extends Omit<Contact, 'history'> {
  history: string
}

function fromRow(r: Row): Contact {
  let history: ContactEvent[] = []
  try {
    history = JSON.parse(r.history) as ContactEvent[]
  } catch {
    history = []
  }
  return { ...r, status: toStatus(r.status) ?? 'not_sent', history }
}

function announce(workspaceId: string): void {
  broadcastToWindows('contacts:changed', { workspaceId })
}

export function listContacts(workspaceId: string): Contact[] {
  return (
    conn()
      .prepare('SELECT * FROM contacts WHERE workspaceId = ? ORDER BY name')
      .all(workspaceId) as Row[]
  ).map(fromRow)
}

export function getContact(id: string): Contact | null {
  const r = conn().prepare('SELECT * FROM contacts WHERE id = ?').get(id) as Row | undefined
  return r ? fromRow(r) : null
}

/** What may be set on a contact; everything optional, read leniently. */
export interface ContactInput {
  name?: unknown
  org?: unknown
  email?: unknown
  channel?: unknown
  ask?: unknown
  status?: unknown
  followUp?: unknown
  notes?: unknown
}

const text = (v: unknown, max = 2000): string | undefined =>
  typeof v === 'string' ? v.trim().slice(0, max) : undefined

function clean(input: ContactInput): Partial<Omit<Contact, 'id' | 'workspaceId' | 'history'>> {
  const out: Partial<Omit<Contact, 'id' | 'workspaceId' | 'history'>> = {}
  for (const k of ['name', 'org', 'email', 'channel', 'ask', 'notes'] as const) {
    const v = text(input[k], k === 'notes' ? 4000 : 300)
    if (v !== undefined) out[k] = k === 'email' ? v.toLowerCase() : v
  }
  if (input.status !== undefined) {
    const s = toStatus(input.status)
    if (s) out.status = s
  }
  if (input.followUp !== undefined) out.followUp = toDay(input.followUp)
  return out
}

export function addContact(
  workspaceId: string,
  input: ContactInput,
  by: ContactEvent['by'] = 'you'
): Contact | null {
  const fields = clean(input)
  if (!fields.name) return null
  const now = Date.now()
  const c: Contact = {
    id: randomUUID(),
    workspaceId,
    name: fields.name,
    org: fields.org ?? '',
    email: fields.email ?? '',
    channel: fields.channel ?? '',
    ask: fields.ask ?? '',
    status: fields.status ?? 'not_sent',
    lastContactAt: null,
    followUp: fields.followUp ?? '',
    notes: fields.notes ?? '',
    history: [{ at: now, by, text: 'Added' }],
    createdAt: now,
    updatedAt: now
  }
  conn()
    .prepare(
      `INSERT INTO contacts (id, workspaceId, name, org, email, channel, ask, status, lastContactAt, followUp, notes, history, createdAt, updatedAt)
       VALUES (@id, @workspaceId, @name, @org, @email, @channel, @ask, @status, @lastContactAt, @followUp, @notes, @history, @createdAt, @updatedAt)`
    )
    .run({ ...c, history: JSON.stringify(c.history) })
  announce(workspaceId)
  return c
}

/**
 * Change a contact. A change of status is written into its history (and counts
 * as having been in touch when it is a reply, a yes or a no); `note` adds a line
 * of its own.
 */
export function updateContact(
  id: string,
  input: ContactInput,
  by: ContactEvent['by'] = 'you',
  note?: string
): Contact | null {
  const c = getContact(id)
  if (!c) return null
  const fields = clean(input)
  if (fields.name === '') delete fields.name
  const now = Date.now()
  const next: Contact = { ...c, ...fields, updatedAt: now, history: [...c.history] }
  if (fields.status && fields.status !== c.status) {
    next.history.push({ at: now, by, text: `Status: ${fields.status.replace('_', ' ')}` })
    if (fields.status === 'replied' || fields.status === 'yes' || fields.status === 'no')
      next.lastContactAt = now
  }
  const n = text(note, 500)
  if (n) next.history.push({ at: now, by, text: n })
  next.history = next.history.slice(-HISTORY_KEPT)
  conn()
    .prepare(
      `UPDATE contacts SET name=@name, org=@org, email=@email, channel=@channel, ask=@ask, status=@status,
       lastContactAt=@lastContactAt, followUp=@followUp, notes=@notes, history=@history, updatedAt=@updatedAt WHERE id=@id`
    )
    .run({ ...next, history: JSON.stringify(next.history) })
  announce(c.workspaceId)
  return next
}

export function deleteContact(id: string): boolean {
  const c = getContact(id)
  if (!c) return false
  conn().prepare('DELETE FROM contacts WHERE id = ?').run(id)
  announce(c.workspaceId)
  return true
}

/**
 * An email went out from this project: every contact of it whose address is
 * among the recipients is now waiting on, with a follow-up a week out.
 * Returns the names it touched.
 */
export function noteEmailSent(
  workspaceId: string,
  recipients: unknown[],
  subject: string,
  now = Date.now()
): string[] {
  const to = new Set(recipients.flatMap((r) => addresses(r)))
  if (!to.size) return []
  const touched: string[] = []
  for (const c of listContacts(workspaceId)) {
    if (!c.email || !to.has(c.email.toLowerCase())) continue
    const r = afterEmail(c, now, subject)
    const history = [...c.history, r.event].slice(-HISTORY_KEPT)
    conn()
      .prepare(
        'UPDATE contacts SET status=?, lastContactAt=?, followUp=?, history=?, updatedAt=? WHERE id=?'
      )
      .run(r.status, r.lastContactAt, r.followUp, JSON.stringify(history), now, c.id)
    touched.push(c.name)
  }
  if (touched.length) announce(workspaceId)
  return touched
}

/** Every project's contacts whose follow-up has come, for Today. */
export function dueContacts(today: string): Contact[] {
  return (
    conn()
      .prepare(
        "SELECT * FROM contacts WHERE status IN ('sent','not_sent') AND followUp != '' AND followUp <= ? ORDER BY followUp"
      )
      .all(today) as Row[]
  ).map(fromRow)
}

/** Find one of a project's contacts by id, or by name or email when the agent has no id. */
export function findContact(workspaceId: string, ref: string): Contact | null {
  const all = listContacts(workspaceId)
  const r = ref.trim().toLowerCase()
  return (
    all.find((c) => c.id === ref) ??
    all.find((c) => c.email && c.email === r) ??
    all.find((c) => c.name.toLowerCase() === r) ??
    null
  )
}

export function registerContactsIpc(): void {
  ipcMain.handle('contacts:list', (_e, ws: string) => listContacts(String(ws)))
  ipcMain.handle('contacts:add', (_e, ws: string, input: ContactInput) =>
    addContact(String(ws), input ?? {}, 'you')
  )
  ipcMain.handle('contacts:update', (_e, id: string, input: ContactInput, note?: string) =>
    updateContact(String(id), input ?? {}, 'you', typeof note === 'string' ? note : undefined)
  )
  ipcMain.handle('contacts:delete', (_e, id: string) => deleteContact(String(id)))
  ipcMain.handle('contacts:due', (_e, today: string) => dueContacts(String(today)))
}

export type { Contact, ContactStatus }
