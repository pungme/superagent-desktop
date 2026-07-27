import { app, ipcMain } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'fs'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

/**
 * SuperAgent persistence: groups → workspaces → tabs.
 * A workspace = a project folder. A tab = a claude/shell/browser pane.
 */

export interface Group {
  id: string
  name: string
  color: string
  collapsed: number
  position: number
}

export type WorkspaceKind = 'app' | 'browser'

export interface Workspace {
  id: string
  groupId: string
  name: string
  path: string
  position: number
  browserUrl: string | null
  lastSessionId: string | null
  kind: WorkspaceKind
}

let db: Database.Database

/** Shared connection to cove.db. Call after initStore() has run (during app startup). */
export function getDb(): Database.Database {
  return db
}

const COLORS = ['#8b8ff8', '#6ee7b7', '#fbbf24', '#f472b6', '#60a5fa', '#fb923c']

export function initStore(): void {
  const dbPath = join(app.getPath('userData'), 'cove.db')
  db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      collapsed INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      groupId TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      position INTEGER NOT NULL,
      browserUrl TEXT,
      lastSessionId TEXT
    );
    CREATE TABLE IF NOT EXISTS chats (
      workspaceId TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      url TEXT PRIMARY KEY,
      title TEXT,
      visitCount INTEGER NOT NULL DEFAULT 1,
      lastVisit INTEGER NOT NULL
    );
  `)

  // Migration: add the project-kind column to pre-existing databases.
  const cols = db.prepare('PRAGMA table_info(workspaces)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'kind')) {
    db.exec("ALTER TABLE workspaces ADD COLUMN kind TEXT NOT NULL DEFAULT 'app'")
  }

  // Seed a default group on first run so the sidebar is never empty.
  const count = (db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n
  if (count === 0) {
    db.prepare(
      'INSERT INTO groups (id, name, color, collapsed, position) VALUES (?, ?, ?, 0, 0)'
    ).run(randomUUID(), 'My projects', COLORS[0])
  }

  // E2E test hook: seed a deterministic workspace so tests don't need the native dialog.
  if (process.env.COVE_E2E_PROJECT) {
    const path = process.env.COVE_E2E_PROJECT
    const exists = db.prepare('SELECT id FROM workspaces WHERE path = ?').get(path)
    if (!exists) {
      const group = db.prepare('SELECT id FROM groups ORDER BY position LIMIT 1').get() as {
        id: string
      }
      db.prepare(
        'INSERT INTO workspaces (id, groupId, name, path, position, browserUrl, lastSessionId) VALUES (?, ?, ?, ?, 0, NULL, NULL)'
      ).run(randomUUID(), group.id, 'e2e-project', path)
    }
  }
}

function nextPosition(table: 'groups' | 'workspaces', where?: [string, string]): number {
  const sql = where
    ? `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM ${table} WHERE ${where[0]} = ?`
    : `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM ${table}`
  const row = (where ? db.prepare(sql).get(where[1]) : db.prepare(sql).get()) as { p: number }
  return row.p
}

export interface TreeGroup extends Group {
  workspaces: Workspace[]
}

export function getTree(): TreeGroup[] {
  const groups = db.prepare('SELECT * FROM groups ORDER BY position').all() as Group[]
  const workspaces = db.prepare('SELECT * FROM workspaces ORDER BY position').all() as Workspace[]
  return groups.map((g) => ({
    ...g,
    workspaces: workspaces.filter((w) => w.groupId === g.id)
  }))
}

export function registerStoreIpc(): void {
  initStore()

  ipcMain.handle('store:tree', () => getTree())

  ipcMain.handle('store:createGroup', (_e, name: string) => {
    const id = randomUUID()
    const color = COLORS[nextPosition('groups') % COLORS.length]
    db.prepare(
      'INSERT INTO groups (id, name, color, collapsed, position) VALUES (?, ?, ?, 0, ?)'
    ).run(id, name || 'New group', color, nextPosition('groups'))
    return getTree()
  })

  ipcMain.handle(
    'store:updateGroup',
    (_e, id: string, patch: Partial<Pick<Group, 'name' | 'color' | 'collapsed'>>) => {
      const cur = db.prepare('SELECT * FROM groups WHERE id = ?').get(id) as Group | undefined
      if (!cur) return getTree()
      db.prepare('UPDATE groups SET name = ?, color = ?, collapsed = ? WHERE id = ?').run(
        patch.name ?? cur.name,
        patch.color ?? cur.color,
        patch.collapsed ?? cur.collapsed,
        id
      )
      return getTree()
    }
  )

  ipcMain.handle('store:deleteGroup', (_e, id: string) => {
    const n = (db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n
    if (n <= 1) return getTree() // keep at least one group
    db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    return getTree()
  })

  ipcMain.handle('store:createWorkspace', (_e, groupId: string, name: string, path: string) => {
    const id = randomUUID()
    db.prepare(
      "INSERT INTO workspaces (id, groupId, name, path, position, browserUrl, lastSessionId, kind) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'app')"
    ).run(id, groupId, name, path, nextPosition('workspaces', ['groupId', groupId]))
    return { tree: getTree(), workspaceId: id }
  })

  // Browser project: no folder to pick — give Claude a private scratch cwd so
  // headless runs/routines have somewhere to work, and mark it kind='browser'.
  ipcMain.handle('store:createBrowserWorkspace', (_e, groupId: string, name: string) => {
    const id = randomUUID()
    const path = join(app.getPath('userData'), 'browser-projects', id)
    mkdirSync(path, { recursive: true })
    db.prepare(
      "INSERT INTO workspaces (id, groupId, name, path, position, browserUrl, lastSessionId, kind) VALUES (?, ?, ?, ?, ?, NULL, NULL, 'browser')"
    ).run(id, groupId, name, path, nextPosition('workspaces', ['groupId', groupId]))
    return { tree: getTree(), workspaceId: id }
  })

  ipcMain.handle('store:deleteWorkspace', (_e, id: string) => {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    db.prepare('DELETE FROM chats WHERE workspaceId = ?').run(id)
    return getTree()
  })

  // Persisted chat transcript (a JSON blob of the conversation) per workspace.
  ipcMain.handle('chat:load', (_e, workspaceId: string) => {
    const row = db.prepare('SELECT data FROM chats WHERE workspaceId = ?').get(workspaceId) as
      { data: string } | undefined
    return row?.data ?? null
  })
  ipcMain.on('chat:save', (_e, workspaceId: string, data: string) => {
    db.prepare(
      'INSERT INTO chats (workspaceId, data) VALUES (?, ?) ON CONFLICT(workspaceId) DO UPDATE SET data = excluded.data'
    ).run(workspaceId, data)
  })
  ipcMain.on('chat:clear', (_e, workspaceId: string) => {
    db.prepare('DELETE FROM chats WHERE workspaceId = ?').run(workspaceId)
  })

  // Browsing history — powers omnibar autocomplete.
  ipcMain.on('history:record', (_e, url: string, title: string, at: number) => {
    if (!/^https?:\/\//i.test(url)) return
    db.prepare(
      `INSERT INTO history (url, title, visitCount, lastVisit) VALUES (?, ?, 1, ?)
       ON CONFLICT(url) DO UPDATE SET
         visitCount = visitCount + 1,
         lastVisit = excluded.lastVisit,
         title = COALESCE(NULLIF(excluded.title, ''), title)`
    ).run(url, title || '', at)
  })
  ipcMain.handle('history:search', (_e, query: string, limit = 6) => {
    const q = `%${query.trim()}%`
    return db
      .prepare(
        `SELECT url, title FROM history
         WHERE url LIKE ? OR title LIKE ?
         ORDER BY visitCount DESC, lastVisit DESC LIMIT ?`
      )
      .all(q, q, limit) as { url: string; title: string }[]
  })

  ipcMain.handle(
    'store:updateWorkspace',
    (_e, id: string, patch: Partial<Pick<Workspace, 'browserUrl' | 'lastSessionId' | 'name'>>) => {
      const cur = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
        Workspace | undefined
      if (!cur) return getTree()
      db.prepare(
        'UPDATE workspaces SET browserUrl = ?, lastSessionId = ?, name = ? WHERE id = ?'
      ).run(
        patch.browserUrl !== undefined ? patch.browserUrl : cur.browserUrl,
        patch.lastSessionId !== undefined ? patch.lastSessionId : cur.lastSessionId,
        patch.name ?? cur.name,
        id
      )
      return getTree()
    }
  )

  ipcMain.handle(
    'store:moveWorkspace',
    (_e, workspaceId: string, toGroupId: string, toIndex: number) => {
      const siblings = db
        .prepare('SELECT id FROM workspaces WHERE groupId = ? AND id != ? ORDER BY position')
        .all(toGroupId, workspaceId) as { id: string }[]
      const order = siblings.map((s) => s.id)
      order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, workspaceId)
      const tx = db.transaction(() => {
        db.prepare('UPDATE workspaces SET groupId = ? WHERE id = ?').run(toGroupId, workspaceId)
        order.forEach((id, i) =>
          db.prepare('UPDATE workspaces SET position = ? WHERE id = ?').run(i, id)
        )
      })
      tx()
      return getTree()
    }
  )
}
