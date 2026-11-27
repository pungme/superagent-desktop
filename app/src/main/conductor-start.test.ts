import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'

const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }))
vi.mock('./util', () => ({ broadcastToWindows: () => undefined }))
vi.mock('./prompts', () => ({ setConductorProbe: () => undefined }))
vi.mock('./store', () => ({
  getDb: () => h.db,
  createChat: (ws: string) => {
    const id = `main-${Math.random().toString(36).slice(2, 7)}`
    ;(h.db as Database.Database)
      .prepare('INSERT INTO chats (id, workspaceId, title, updatedAt) VALUES (?, ?, NULL, 0)')
      .run(id, ws)
    return id
  },
  getChat: () => undefined,
  getWorkspace: () => ({ name: 'proj', path: '/tmp' }),
  listChatEvents: () => [],
  markPendingBranch: () => undefined,
  setChatTitle: () => undefined
}))

const { startConductorDialog } = await import('./conductor-tools')
const { getConductor, listSessions } = await import('./conductor-store')

beforeEach(() => {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE workspaces (id TEXT PRIMARY KEY, conductorChatId TEXT,
      conductorNextTicket INTEGER NOT NULL DEFAULT 101, conductorRouting TEXT NOT NULL DEFAULT 'confirm');
    CREATE TABLE chats (id TEXT PRIMARY KEY, workspaceId TEXT, title TEXT, updatedAt INTEGER,
      position INTEGER NOT NULL DEFAULT 0, incognito INTEGER NOT NULL DEFAULT 0, conductorParentId TEXT,
      ticketNumber INTEGER, conductorClosedAt INTEGER, conductorSummary TEXT);
    INSERT INTO workspaces (id) VALUES ('w1');
  `)
  h.db = db
})
const addChat = (id: string): void =>
  void (h.db as Database.Database)
    .prepare('INSERT INTO chats (id, workspaceId, updatedAt) VALUES (?, ?, 1)')
    .run(id, 'w1')

describe('Start Conductor… from the project menu', () => {
  it('on a project with no chats asks Start / Cancel, and Start turns it on', async () => {
    const asked: string[][] = []
    const made = await startConductorDialog('w1', async (o) => (asked.push(o.buttons), 0))
    expect(asked).toEqual([['Start', 'Cancel']])
    expect(made?.chatId).toBeTruthy()
    expect(getConductor(h.db as never, 'w1')?.chatId).toBe(made!.chatId)
  })

  it('Cancel turns nothing on', async () => {
    expect(await startConductorDialog('w1', async () => 1)).toBeNull()
    expect(getConductor(h.db as never, 'w1')).toBeNull()
  })

  it('with existing chats: Start clean leaves them alone, Connect numbers them', async () => {
    addChat('a')
    addChat('b')
    const clean = await startConductorDialog('w1', async (o) => {
      expect(o.buttons).toEqual(['Start clean', 'Connect the 2 existing chats', 'Cancel'])
      return 0
    })
    expect(clean).not.toBeNull()
    expect(listSessions(h.db as never, 'w1')).toHaveLength(0)
    ;(h.db as Database.Database).exec(
      "UPDATE workspaces SET conductorChatId = NULL; DELETE FROM chats WHERE id LIKE 'main-%'"
    )
    const connected = await startConductorDialog('w1', async () => 1)
    expect(connected).not.toBeNull()
    expect(listSessions(h.db as never, 'w1').map((s) => s.ticket)).toEqual([101, 102])
  })

  it('Cancel with existing chats is the third button', async () => {
    addChat('a')
    expect(await startConductorDialog('w1', async () => 2)).toBeNull()
  })
})
