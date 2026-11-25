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
  FIELDS_MAX,
  FIELD_VALUE_MAX,
  fieldKey,
  guessFieldType,
  type Contact,
  type ContactEvent,
  type ContactStatus,
  type FieldDef
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
    -- The project's own fields, and where each sits in the list.
    CREATE TABLE IF NOT EXISTS contact_fields (
      workspaceId TEXT NOT NULL,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'text',
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (workspaceId, key)
    );
  `)
  const cols = d.prepare('PRAGMA table_info(contacts)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'fields'))
    d.exec("ALTER TABLE contacts ADD COLUMN fields TEXT NOT NULL DEFAULT '{}'")
  return d
}

/** Tests only: a database of the test's own. */
export function _useDbForTests(d: Database.Database): void {
  db = schema(d)
}

const HISTORY_KEPT = 50

interface Row extends Omit<Contact, 'history' | 'fields'> {
  history: string
  fields: string
}

function fromRow(r: Row): Contact {
  let history: ContactEvent[] = []
  try {
    history = JSON.parse(r.history) as ContactEvent[]
  } catch {
    history = []
  }
  let fields: Record<string, string> = {}
  try {
    const parsed = JSON.parse(r.fields || '{}') as Record<string, unknown>
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') fields[k] = v
  } catch {
    fields = {}
  }
  return { ...r, status: toStatus(r.status) ?? 'not_sent', history, fields }
}

// --- the project's own fields -----------------------------------------------

export function listFields(workspaceId: string): FieldDef[] {
  return conn()
    .prepare(
      'SELECT key, label, type FROM contact_fields WHERE workspaceId = ? ORDER BY position, label'
    )
    .all(workspaceId) as FieldDef[]
}

/**
 * Make sure a field exists, by its label: the same label (any case or accent) is
 * the same field. null when there is no usable label or the project has as many
 * fields as it may.
 */
export function ensureField(
  workspaceId: string,
  label: string,
  sample = '',
  type?: FieldDef['type']
): FieldDef | null {
  const clean = label.trim().slice(0, 60)
  const key = fieldKey(clean)
  if (!key) return null
  const have = listFields(workspaceId)
  const found = have.find((f) => f.key === key)
  if (found) return found
  if (have.length >= FIELDS_MAX) return null
  const def: FieldDef = { key, label: clean, type: type ?? guessFieldType(sample) }
  conn()
    .prepare(
      'INSERT INTO contact_fields (workspaceId, key, label, type, position) VALUES (?, ?, ?, ?, ?)'
    )
    .run(workspaceId, def.key, def.label, def.type, have.length)
  return def
}

/** Take a field away from the project and from every contact that has it. */
export function removeField(workspaceId: string, key: string): boolean {
  const d = conn()
  const gone = d
    .prepare('DELETE FROM contact_fields WHERE workspaceId = ? AND key = ?')
    .run(workspaceId, key).changes
  if (!gone) return false
  for (const c of listContacts(workspaceId)) {
    if (!(key in c.fields)) continue
    const rest = { ...c.fields }
    delete rest[key]
    d.prepare('UPDATE contacts SET fields = ? WHERE id = ?').run(JSON.stringify(rest), c.id)
  }
  announce(workspaceId)
  return true
}

/**
 * Values by label → values by key, defining the fields that are new. An empty
 * value clears the field on that contact (a new field with no value is still
 * defined, so it shows up to be filled in).
 */
function applyFields(
  workspaceId: string,
  current: Record<string, string>,
  input: unknown
): Record<string, string> {
  const out = { ...current }
  if (!input || typeof input !== 'object') return out
  for (const [label, raw] of Object.entries(input as Record<string, unknown>)) {
    const value = (typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '')
      .trim()
      .slice(0, FIELD_VALUE_MAX)
    const def = ensureField(workspaceId, label, value)
    if (!def) continue
    if (value) out[def.key] = value
    else delete out[def.key]
  }
  return out
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
  /** The project's own fields, by label. */
  fields?: unknown
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
    fields: applyFields(workspaceId, {}, input.fields),
    history: [{ at: now, by, text: 'Added' }],
    createdAt: now,
    updatedAt: now
  }
  conn()
    .prepare(
      `INSERT INTO contacts (id, workspaceId, name, org, email, channel, ask, status, lastContactAt, followUp, notes, fields, history, createdAt, updatedAt)
       VALUES (@id, @workspaceId, @name, @org, @email, @channel, @ask, @status, @lastContactAt, @followUp, @notes, @fields, @history, @createdAt, @updatedAt)`
    )
    .run({ ...c, fields: JSON.stringify(c.fields), history: JSON.stringify(c.history) })
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
  const next: Contact = {
    ...c,
    ...fields,
    fields:
      input.fields === undefined ? c.fields : applyFields(c.workspaceId, c.fields, input.fields),
    updatedAt: now,
    history: [...c.history]
  }
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
       lastContactAt=@lastContactAt, followUp=@followUp, notes=@notes, fields=@fields, history=@history, updatedAt=@updatedAt WHERE id=@id`
    )
    .run({ ...next, fields: JSON.stringify(next.fields), history: JSON.stringify(next.history) })
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
  ipcMain.handle('contacts:fields', (_e, ws: string) => listFields(String(ws)))
  ipcMain.handle('contacts:remove-field', (_e, ws: string, key: string) =>
    removeField(String(ws), String(key))
  )
  ipcMain.handle('contacts:due', (_e, today: string) => dueContacts(String(today)))
}

export type { Contact, ContactStatus }
