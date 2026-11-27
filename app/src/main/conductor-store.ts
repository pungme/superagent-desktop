import type Database from 'better-sqlite3'
import { FIRST_TICKET, type ConductorRouting } from '../shared/conductor'

/**
 * Conductor's rows (plan: .superagent/cto-mode/plan.md). A project's Main chat is
 * `workspaces.conductorChatId`; its workers are the project's chats whose `conductorParentId`
 * points at it, each with a per-project ticket number that stays with it when it is
 * disconnected and connected again, or closed and reopened.
 *
 * Plain functions over a database handle, so they run against an in-memory one in tests.
 */
export interface ConductorInfo {
  workspaceId: string
  chatId: string
  routing: ConductorRouting
  nextTicket: number
}

export interface SessionRow {
  chatId: string
  title: string
  ticket: number | null
  summary: string
  closedAt: number | null
  updatedAt: number
  parentId: string | null
}

type Db = Database.Database

export function getConductor(db: Db, workspaceId: string): ConductorInfo | null {
  const r = db
    .prepare(
      'SELECT id, conductorChatId, conductorRouting, conductorNextTicket FROM workspaces WHERE id = ?'
    )
    .get(workspaceId) as
    | {
        id: string
        conductorChatId: string | null
        conductorRouting: string
        conductorNextTicket: number
      }
    | undefined
  if (!r?.conductorChatId) return null
  return {
    workspaceId: r.id,
    chatId: r.conductorChatId,
    routing: r.conductorRouting === 'auto' ? 'auto' : 'confirm',
    nextTicket: r.conductorNextTicket || FIRST_TICKET
  }
}

/** The Conductor a chat is the Main of, or null for any other chat. */
export function conductorOfMain(db: Db, chatId: string): ConductorInfo | null {
  const r = db.prepare('SELECT id FROM workspaces WHERE conductorChatId = ?').get(chatId) as
    { id: string } | undefined
  return r ? getConductor(db, r.id) : null
}

/** The Conductor a worker chat belongs to, or null when it is not connected to one. */
export function conductorOfWorker(db: Db, chatId: string): ConductorInfo | null {
  const r = db
    .prepare('SELECT workspaceId, conductorParentId FROM chats WHERE id = ?')
    .get(chatId) as { workspaceId: string; conductorParentId: string | null } | undefined
  if (!r?.conductorParentId) return null
  const c = getConductor(db, r.workspaceId)
  return c && c.chatId === r.conductorParentId ? c : null
}

/** Take the next ticket number of a project. */
export function nextTicket(db: Db, workspaceId: string): number {
  return db.transaction((): number => {
    const r = db
      .prepare('SELECT conductorNextTicket AS n FROM workspaces WHERE id = ?')
      .get(workspaceId) as { n: number } | undefined
    const n = r?.n || FIRST_TICKET
    db.prepare('UPDATE workspaces SET conductorNextTicket = ? WHERE id = ?').run(n + 1, workspaceId)
    return n
  })()
}

/**
 * Turn Conductor on for a project: make (or keep) its Main chat and, when asked, connect
 * existing chats under it. `makeMain` creates the Main chat; it is not called when the project
 * already has one.
 */
export function enableConductor(
  db: Db,
  workspaceId: string,
  opts: { adoptChatIds?: string[]; makeMain: () => string }
): ConductorInfo {
  const existing = getConductor(db, workspaceId)
  if (existing) return existing
  db.transaction(() => {
    const main = opts.makeMain()
    db.prepare('UPDATE chats SET title = COALESCE(title, ?) WHERE id = ?').run('Main', main)
    db.prepare('UPDATE workspaces SET conductorChatId = ? WHERE id = ?').run(main, workspaceId)
  })()
  for (const id of opts.adoptChatIds ?? []) connectChat(db, workspaceId, id)
  return getConductor(db, workspaceId)!
}

export function listSessions(
  db: Db,
  workspaceId: string,
  opts: { includeClosed?: boolean } = {}
): SessionRow[] {
  const c = getConductor(db, workspaceId)
  if (!c) return []
  const rows = db
    .prepare(
      `SELECT id, title, ticketNumber, conductorSummary, conductorClosedAt, updatedAt, conductorParentId
       FROM chats WHERE workspaceId = ? AND conductorParentId = ?
       ORDER BY ticketNumber, updatedAt`
    )
    .all(workspaceId, c.chatId) as {
    id: string
    title: string | null
    ticketNumber: number | null
    conductorSummary: string | null
    conductorClosedAt: number | null
    updatedAt: number
    conductorParentId: string | null
  }[]
  return rows
    .filter((r) => opts.includeClosed || r.conductorClosedAt == null)
    .map((r) => ({
      chatId: r.id,
      title: r.title ?? '',
      ticket: r.ticketNumber,
      summary: r.conductorSummary ?? '',
      closedAt: r.conductorClosedAt,
      updatedAt: r.updatedAt,
      parentId: r.conductorParentId
    }))
}

/** Chats of the project that are not Main and not connected to it. */
export function listUnlinked(db: Db, workspaceId: string): { chatId: string; title: string }[] {
  const c = getConductor(db, workspaceId)
  if (!c) return []
  return (
    db
      .prepare(
        `SELECT id, title FROM chats
         WHERE workspaceId = ? AND id <> ? AND conductorParentId IS NULL AND incognito = 0
         ORDER BY updatedAt DESC`
      )
      .all(workspaceId, c.chatId) as { id: string; title: string | null }[]
  ).map((r) => ({ chatId: r.id, title: r.title ?? '' }))
}

/** Put a chat of this project under its Main. Returns its ticket, or null if it cannot be. */
export function connectChat(db: Db, workspaceId: string, chatId: string): number | null {
  const c = getConductor(db, workspaceId)
  if (!c || chatId === c.chatId) return null
  const chat = db
    .prepare('SELECT workspaceId, ticketNumber FROM chats WHERE id = ?')
    .get(chatId) as { workspaceId: string; ticketNumber: number | null } | undefined
  if (!chat || chat.workspaceId !== workspaceId) return null
  const ticket = chat.ticketNumber ?? nextTicket(db, workspaceId)
  db.prepare(
    'UPDATE chats SET conductorParentId = ?, ticketNumber = ?, conductorClosedAt = NULL WHERE id = ?'
  ).run(c.chatId, ticket, chatId)
  return ticket
}

/** Let a chat go: it stays a chat of the project, and keeps its ticket for a later connect. */
export function disconnectChat(db: Db, chatId: string): boolean {
  return (
    db.prepare('UPDATE chats SET conductorParentId = NULL WHERE id = ?').run(chatId).changes > 0
  )
}

export function closeSession(db: Db, chatId: string, now = Date.now()): boolean {
  return (
    db
      .prepare(
        'UPDATE chats SET conductorClosedAt = ? WHERE id = ? AND conductorParentId IS NOT NULL'
      )
      .run(now, chatId).changes > 0
  )
}

export function reopenSession(db: Db, chatId: string): boolean {
  return (
    db
      .prepare(
        'UPDATE chats SET conductorClosedAt = NULL WHERE id = ? AND conductorParentId IS NOT NULL'
      )
      .run(chatId).changes > 0
  )
}

export function setRouting(db: Db, workspaceId: string, mode: ConductorRouting): boolean {
  return (
    db
      .prepare(
        'UPDATE workspaces SET conductorRouting = ? WHERE id = ? AND conductorChatId IS NOT NULL'
      )
      .run(mode === 'auto' ? 'auto' : 'confirm', workspaceId).changes > 0
  )
}

export function setSummary(db: Db, chatId: string, summary: string): void {
  db.prepare('UPDATE chats SET conductorSummary = ? WHERE id = ?').run(
    summary.slice(0, 400),
    chatId
  )
}

/** Which session a "#101" or a chat id means, among a project's sessions. */
export function findSession(
  db: Db,
  workspaceId: string,
  ref: { ticket?: number; chatId?: string }
): SessionRow | undefined {
  return listSessions(db, workspaceId, { includeClosed: true }).find((s) =>
    ref.chatId ? s.chatId === ref.chatId : ref.ticket != null && s.ticket === ref.ticket
  )
}
