import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import Database from 'better-sqlite3'

/**
 * What the Sessions panel shows without a word from the workers: a one-line summary when a worker's
 * turn ends, and "Needs you" (with what it asks) while one of its approvals is open.
 */
const h = vi.hoisted(() => ({ db: null as unknown, sent: [] as string[] }))

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
vi.mock('./util', () => ({ broadcastToWindows: (c: string) => h.sent.push(c) }))
vi.mock('./prompts', () => ({ setConductorProbe: () => undefined }))
vi.mock('./store', () => ({
  getDb: () => h.db,
  getChat: () => ({ cwd: null }),
  getWorkspace: () => ({ name: 'proj', path: '/tmp' }),
  createChat: () => 'x',
  listChatEvents: () => [],
  markPendingBranch: () => undefined,
  setChatTitle: () => undefined
}))

const { watchConductor, sessionsOf, setGeneratingProbe } = await import('./conductor-tools')
const { enableConductor, connectChat, getConductor } = await import('./conductor-store')

let logBus: EventEmitter
let hookBus: EventEmitter

beforeEach(() => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, conductorChatId TEXT,
      conductorNextTicket INTEGER NOT NULL DEFAULT 101, conductorRouting TEXT NOT NULL DEFAULT 'confirm');
    CREATE TABLE chats (id TEXT PRIMARY KEY, workspaceId TEXT, title TEXT, updatedAt INTEGER,
      incognito INTEGER NOT NULL DEFAULT 0, conductorParentId TEXT, ticketNumber INTEGER,
      conductorClosedAt INTEGER, conductorSummary TEXT);
    INSERT INTO workspaces (id) VALUES ('w1');
    INSERT INTO chats (id, workspaceId, title, updatedAt) VALUES ('main', 'w1', NULL, 1), ('wk', 'w1', 'Fix header', 2);
  `)
  h.db = db
  h.sent.length = 0
  enableConductor(db, 'w1', { makeMain: () => 'main' })
  connectChat(db, 'w1', 'wk')
  logBus = new EventEmitter()
  hookBus = new EventEmitter()
  watchConductor(logBus, hookBus)
  setGeneratingProbe(() => false)
})

const sessions = (): ReturnType<typeof sessionsOf> => sessionsOf(getConductor(h.db as never, 'w1')!)

describe('conductor: what the workers say without being asked', () => {
  it('leaves the first sentence of its last reply when a turn ends', () => {
    logBus.emit('event', {
      event: {
        chatId: 'wk',
        data: { kind: 'assistant', text: 'I fixed the header so it never wraps. More detail here.' }
      }
    })
    logBus.emit('event', { event: { chatId: 'wk', data: { kind: 'turn_end' } } })
    expect(sessions()[0].summary).toBe('I fixed the header so it never wraps.')
    expect(h.sent).toContain('conductor:changed')
  })

  it('shows Needs you, and what it asks, until the approval is answered', () => {
    hookBus.emit('approval', { requestId: 'r1', sessionId: 'wk', preview: 'Run: rm -rf build' })
    expect(sessions()[0].status).toBe('needs-you')
    expect(sessions()[0].approval).toEqual({ requestId: 'r1', preview: 'Run: rm -rf build' })
    hookBus.emit('approval-end', { requestId: 'r1' })
    expect(sessions()[0].status).toBe('idle')
    expect(sessions()[0].approval).toBeUndefined()
  })

  it('ignores a chat that is not a session', () => {
    logBus.emit('event', {
      event: {
        chatId: 'other',
        data: { kind: 'assistant', text: 'Hello there, this is long enough.' }
      }
    })
    logBus.emit('event', { event: { chatId: 'other', data: { kind: 'turn_end' } } })
    expect(h.sent).toEqual([])
  })
})
