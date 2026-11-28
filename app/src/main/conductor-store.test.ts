import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  closeSession,
  conductorMarks,
  forget,
  memoryIndex,
  recall,
  remember,
  conductorOfMain,
  conductorOfWorker,
  connectChat,
  disconnectChat,
  enableConductor,
  findSession,
  getConductor,
  listSessions,
  listUnlinked,
  nextTicket,
  reopenSession,
  setRouting,
  setSummary
} from './conductor-store'

let db: Database.Database
let n = 0
const addChat = (ws: string, title: string | null = null): string => {
  const id = `c${++n}`
  db.prepare(
    'INSERT INTO chats (id, workspaceId, title, updatedAt, incognito) VALUES (?, ?, ?, ?, 0)'
  ).run(id, ws, title, n)
  return id
}

beforeEach(() => {
  n = 0
  db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, conductorChatId TEXT,
      conductorNextTicket INTEGER NOT NULL DEFAULT 101, conductorRouting TEXT NOT NULL DEFAULT 'confirm');
    CREATE TABLE chats (id TEXT PRIMARY KEY, workspaceId TEXT, title TEXT, updatedAt INTEGER,
      incognito INTEGER NOT NULL DEFAULT 0, conductorParentId TEXT, ticketNumber INTEGER,
      conductorClosedAt INTEGER, conductorSummary TEXT);
    INSERT INTO workspaces (id) VALUES ('w1'), ('w2');
  `)
})

describe('conductor rows', () => {
  it('is off until enabled, and enabling twice keeps the one Main', () => {
    expect(getConductor(db, 'w1')).toBeNull()
    const a = enableConductor(db, 'w1', { makeMain: () => addChat('w1') })
    const b = enableConductor(db, 'w1', { makeMain: () => addChat('w1') })
    expect(b.chatId).toBe(a.chatId)
    expect(conductorOfMain(db, a.chatId)?.workspaceId).toBe('w1')
    expect(db.prepare('SELECT title FROM chats WHERE id = ?').get(a.chatId)).toEqual({
      title: 'Main'
    })
    expect(db.prepare('SELECT COUNT(*) AS n FROM chats').get()).toEqual({ n: 1 })
  })

  it('connects existing chats and numbers them from 101, per project', () => {
    const x = addChat('w1', 'X')
    const y = addChat('w1', 'Y')
    const other = addChat('w2', 'Other')
    enableConductor(db, 'w1', { adoptChatIds: [x, y], makeMain: () => addChat('w1') })
    enableConductor(db, 'w2', { adoptChatIds: [other], makeMain: () => addChat('w2') })
    const s = listSessions(db, 'w1')
    expect(s.map((r) => [r.title, r.ticket])).toEqual([
      ['X', 101],
      ['Y', 102]
    ])
    expect(listSessions(db, 'w2')[0].ticket).toBe(101)
    expect(getConductor(db, 'w1')?.nextTicket).toBe(103)
  })

  it('refuses a chat of another project and the Main itself', () => {
    const c = enableConductor(db, 'w1', { makeMain: () => addChat('w1') })
    const foreign = addChat('w2')
    expect(connectChat(db, 'w1', foreign)).toBeNull()
    expect(connectChat(db, 'w1', c.chatId)).toBeNull()
    expect(connectChat(db, 'w1', 'nope')).toBeNull()
  })

  it('keeps a ticket through disconnect and connect, and through close and reopen', () => {
    const c = enableConductor(db, 'w1', { makeMain: () => addChat('w1') })
    const x = addChat('w1', 'X')
    expect(connectChat(db, 'w1', x)).toBe(101)
    expect(conductorOfWorker(db, x)?.chatId).toBe(c.chatId)
    disconnectChat(db, x)
    expect(conductorOfWorker(db, x)).toBeNull()
    expect(listUnlinked(db, 'w1').map((r) => r.chatId)).toEqual([x])
    expect(connectChat(db, 'w1', x)).toBe(101)
    expect(closeSession(db, x, 5)).toBe(true)
    expect(listSessions(db, 'w1')).toHaveLength(0)
    expect(listSessions(db, 'w1', { includeClosed: true })[0].closedAt).toBe(5)
    expect(reopenSession(db, x)).toBe(true)
    expect(listSessions(db, 'w1')[0].ticket).toBe(101)
  })

  it('only a connected chat can be closed', () => {
    enableConductor(db, 'w1', { makeMain: () => addChat('w1') })
    expect(closeSession(db, addChat('w1'))).toBe(false)
  })

  it('hands out increasing tickets', () => {
    enableConductor(db, 'w1', { makeMain: () => addChat('w1') })
    expect([nextTicket(db, 'w1'), nextTicket(db, 'w1'), nextTicket(db, 'w1')]).toEqual([
      101, 102, 103
    ])
  })

  it('stores the routing mode and a session summary, and finds a session by ticket', () => {
    enableConductor(db, 'w1', { makeMain: () => addChat('w1') })
    expect(setRouting(db, 'w1', 'auto')).toBe(true)
    expect(getConductor(db, 'w1')?.routing).toBe('auto')
    expect(setRouting(db, 'w2', 'auto')).toBe(false)
    const x = addChat('w1', 'X')
    connectChat(db, 'w1', x)
    setSummary(db, x, 'Waiting for review')
    expect(findSession(db, 'w1', { ticket: 101 })?.summary).toBe('Waiting for review')
    expect(findSession(db, 'w1', { chatId: x })?.ticket).toBe(101)
    expect(findSession(db, 'w1', { ticket: 999 })).toBeUndefined()
  })

  it('marks the Main and each session for clients that only see the chat list', () => {
    const c = enableConductor(db, 'w1', { makeMain: () => addChat('w1') })
    const x = addChat('w1', 'X')
    const y = addChat('w1', 'Y')
    const plain = addChat('w1', 'Plain')
    connectChat(db, 'w1', x)
    connectChat(db, 'w1', y)
    closeSession(db, y, 5)
    const m = conductorMarks(db)
    expect(m.get(c.chatId)).toEqual({ conductor: 'main' })
    expect(m.get(x)).toEqual({ conductor: 'session', ticket: 101 })
    expect(m.get(y)).toEqual({ conductor: 'session', ticket: 102, closed: true })
    expect(m.has(plain)).toBe(false)
  })

  it("keeps Main's memory per project: one entry per key, recall by words or kind, forget", () => {
    remember(db, 'w1', 'auth flow', 'decision', 'Magic links only, no passwords', 1)
    remember(db, 'w1', 'campaign table', 'structure', 't800_campaigns: id, status, deleted', 2)
    remember(db, 'w2', 'other', 'fact', 'not mine', 3)
    // Saving the same key again updates it.
    remember(db, 'w1', 'auth flow', 'decision', 'Magic links and Google', 4)
    expect(recall(db, 'w1').map((r) => r.key)).toEqual(['auth flow', 'campaign table'])
    expect(recall(db, 'w1', { query: 'google' })[0].text).toBe('Magic links and Google')
    expect(recall(db, 'w1', { query: 'status deleted' }).map((r) => r.key)).toEqual([
      'campaign table'
    ])
    expect(recall(db, 'w1', { kind: 'structure' })).toHaveLength(1)
    expect(memoryIndex(db, 'w1')).toContain('[structure] campaign table')
    expect(memoryIndex(db, 'w1')).not.toContain('not mine')
    expect(forget(db, 'w1', 'auth flow')).toBe(true)
    expect(forget(db, 'w1', 'auth flow')).toBe(false)
    expect(recall(db, 'w1')).toHaveLength(1)
    expect(memoryIndex(db, 'w3')).toBe('')
  })
})
