import { app, ipcMain } from 'electron'
import { join } from 'path'
import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'

/**
 * Cove persistence: groups → workspaces → tabs.
 * A workspace = a project folder. A tab = a claude/shell/browser pane.
 */

export interface Group {
  id: string
  name: string
  color: string
  collapsed: number
  position: number
}

export interface Workspace {
  id: string
  groupId: string
  name: string
  path: string
  position: number
  browserUrl: string | null
  lastSessionId: string | null
}

export interface Tab {
  id: string
  workspaceId: string
  kind: 'claude' | 'shell' | 'browser'
  title: string
  position: number
}

let db: Database.Database

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
    CREATE TABLE IF NOT EXISTS tabs (
      id TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      position INTEGER NOT NULL
    );
  `)

  // Seed a default group on first run so the sidebar is never empty.
  const count = (db.prepare('SELECT COUNT(*) AS n FROM groups').get() as { n: number }).n
  if (count === 0) {
    db.prepare('INSERT INTO groups (id, name, color, collapsed, position) VALUES (?, ?, ?, 0, 0)').run(
      randomUUID(),
      'My projects',
      COLORS[0]
    )
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
  const workspaces = db
    .prepare('SELECT * FROM workspaces ORDER BY position')
    .all() as Workspace[]
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
    db.prepare('INSERT INTO groups (id, name, color, collapsed, position) VALUES (?, ?, ?, 0, ?)').run(
      id,
      name || 'New group',
      color,
      nextPosition('groups')
    )
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
      'INSERT INTO workspaces (id, groupId, name, path, position, browserUrl, lastSessionId) VALUES (?, ?, ?, ?, ?, NULL, NULL)'
    ).run(id, groupId, name, path, nextPosition('workspaces', ['groupId', groupId]))
    return { tree: getTree(), workspaceId: id }
  })

  ipcMain.handle('store:deleteWorkspace', (_e, id: string) => {
    db.prepare('DELETE FROM workspaces WHERE id = ?').run(id)
    return getTree()
  })

  ipcMain.handle(
    'store:updateWorkspace',
    (_e, id: string, patch: Partial<Pick<Workspace, 'browserUrl' | 'lastSessionId' | 'name'>>) => {
      const cur = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as
        | Workspace
        | undefined
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
