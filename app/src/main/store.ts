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
      id TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      title TEXT,
      claudeSessionId TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      updatedAt INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS events (
      ts INTEGER NOT NULL,
      workspaceId TEXT,
      kind TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
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

  // Migration: a numeric payload on events — token counts ride on kind='tokens'.
  const evCols = db.prepare('PRAGMA table_info(events)').all() as { name: string }[]
  if (!evCols.some((c) => c.name === 'n')) {
    db.exec('ALTER TABLE events ADD COLUMN n INTEGER NOT NULL DEFAULT 0')
  }

  // Migration: chats used to be one-per-workspace (workspaceId was the primary
  // key), which is why "New chat" had to delete the old one — there was nowhere
  // to put a second. Re-key by chat id and carry each existing transcript over
  // as that project's first chat, keeping its resumable claude session.
  const chatCols = db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]
  if (!chatCols.some((c) => c.name === 'id')) {
    const existing = db.prepare('SELECT workspaceId, data FROM chats').all() as {
      workspaceId: string
      data: string
    }[]
    const sessions = db.prepare('SELECT id, lastSessionId FROM workspaces').all() as {
      id: string
      lastSessionId: string | null
    }[]
    const sessionFor = new Map(sessions.map((w) => [w.id, w.lastSessionId]))

    db.exec(`
      DROP TABLE chats;
      CREATE TABLE chats (
        id TEXT PRIMARY KEY,
        workspaceId TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        title TEXT,
        claudeSessionId TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        updatedAt INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
    `)
    const insert = db.prepare(
      'INSERT INTO chats (id, workspaceId, title, claudeSessionId, position, updatedAt, data) VALUES (?, ?, ?, ?, 0, ?, ?)'
    )
    const now = Date.now()
    for (const row of existing) {
      insert.run(
        randomUUID(),
        row.workspaceId,
        null,
        sessionFor.get(row.workspaceId) ?? null,
        now,
        row.data
      )
    }
  }

  // Migration: a chat may run in its own git worktree; cwd overrides the project
  // path. Runs AFTER the rekey migration above, which recreates the table.
  const chatCols2 = db.prepare('PRAGMA table_info(chats)').all() as { name: string }[]
  if (chatCols2.length > 0 && !chatCols2.some((c) => c.name === 'cwd')) {
    db.exec('ALTER TABLE chats ADD COLUMN cwd TEXT')
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

/** A workspace's kind ('browser' | 'app'), for picking its session partition. */
export function getWorkspaceKind(id: string): WorkspaceKind | undefined {
  const row = db.prepare('SELECT kind FROM workspaces WHERE id = ?').get(id) as
    | { kind: WorkspaceKind }
    | undefined
  return row?.kind
}

/** A workspace's project path, for resolving a relative file path the agent passes. */
export function getWorkspacePath(id: string): string | undefined {
  const row = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(id) as
    | { path: string }
    | undefined
  return row?.path
}

export function getRecentHistory(limit = 6): { url: string; title: string }[] {
  return db
    .prepare('SELECT url, title FROM history ORDER BY visitCount DESC, lastVisit DESC LIMIT ?')
    .all(limit) as { url: string; title: string }[]
}

export function getWorkspaceName(id: string): string | undefined {
  const row = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(id) as
    | { name: string }
    | undefined
  return row?.name
}

/**
 * The conversation a hook event came from, matched on Claude's own session id.
 * Chats name themselves after what they turned out to be about, so this is the
 * one line that says what a notification is *for* — "Finished" on its own tells
 * you nothing when four projects are running.
 */
export function getChatTitleBySession(sessionId: string): string | undefined {
  const row = db.prepare('SELECT title FROM chats WHERE claudeSessionId = ?').get(sessionId) as
    | { title: string | null }
    | undefined
  return row?.title ?? undefined
}

/** Append to the activity log the dashboard reads. Cheap, fire-and-forget. */
export function recordEvent(kind: string, workspaceId?: string | null, n = 0): void {
  try {
    db.prepare('INSERT INTO events (ts, workspaceId, kind, n) VALUES (?, ?, ?, ?)').run(
      Date.now(),
      workspaceId ?? null,
      kind,
      Math.max(0, Math.floor(n) || 0)
    )
  } catch {
    // never let bookkeeping break the app
  }
}

/**
 * Everything the dashboard shows. The events table only started filling in
 * v1.1, but chat transcripts carry per-message timestamps going back much
 * further — so turns are reconstructed from both sources. Where a day has
 * entries from both (recent sessions log each turn twice: once as an event,
 * once as a saved assistant message), the richer source wins for that day
 * rather than double-counting.
 */
export function getDashboard(): unknown {
  const dayMs = 86_400_000
  const now = Date.now()
  const startOfToday = new Date().setHours(0, 0, 0, 0)
  const tzOffMs = new Date().getTimezoneOffset() * 60_000
  const dayOf = (ts: number): number => Math.floor((ts - tzOffMs) / dayMs)

  type Entry = { ts: number; ws: string | null }
  const evEntries: Entry[] = (
    db.prepare("SELECT ts, workspaceId ws FROM events WHERE kind='turn'").all() as {
      ts: number
      ws: string | null
    }[]
  ).map((r) => ({ ts: r.ts, ws: r.ws }))

  // Backfill from transcripts: every saved assistant message is one turn.
  const msgEntries: Entry[] = []
  let totalMessages = 0
  const chatRows = db.prepare('SELECT workspaceId, data FROM chats').all() as {
    workspaceId: string
    data: string
  }[]
  for (const row of chatRows) {
    try {
      const items = JSON.parse(row.data) as {
        kind?: string
        msg?: { role?: string; at?: number; system?: boolean }
      }[]
      if (!Array.isArray(items)) continue
      for (const it of items) {
        if (it?.kind !== 'msg' || !it.msg || it.msg.system) continue
        totalMessages += 1
        if (it.msg.role === 'assistant' && typeof it.msg.at === 'number')
          msgEntries.push({ ts: it.msg.at, ws: row.workspaceId })
      }
    } catch {
      // one corrupt transcript shouldn't blank the dashboard
    }
  }

  // Per-day, keep whichever source saw more turns that day.
  const byDay = (list: Entry[]): Map<number, Entry[]> => {
    const m = new Map<number, Entry[]>()
    for (const e of list) {
      const d = dayOf(e.ts)
      const arr = m.get(d)
      if (arr) arr.push(e)
      else m.set(d, [e])
    }
    return m
  }
  const evByDay = byDay(evEntries)
  const msgByDay = byDay(msgEntries)
  const turns: Entry[] = []
  for (const d of new Set([...evByDay.keys(), ...msgByDay.keys()])) {
    const ev = evByDay.get(d) ?? []
    const msg = msgByDay.get(d) ?? []
    turns.push(...(msg.length >= ev.length ? msg : ev))
  }

  const today = dayOf(now)
  const turnsToday = turns.filter((e) => dayOf(e.ts) === today).length
  const tasksToday = (
    db
      .prepare("SELECT COUNT(*) n FROM events WHERE kind='task-done' AND ts >= ?")
      .get(startOfToday) as { n: number }
  ).n
  const tasksTotal = (
    db.prepare("SELECT COUNT(*) n FROM events WHERE kind='task-done'").get() as { n: number }
  ).n

  // Streaks over the merged turn days: current (ending today/yesterday) + longest ever.
  const days = new Set(turns.map((e) => dayOf(e.ts)))
  let streak = 0
  let cursor = today
  if (!days.has(cursor)) cursor -= 1
  while (days.has(cursor)) {
    streak += 1
    cursor -= 1
  }
  let longestStreak = 0
  const sortedDays = [...days].sort((a, b) => a - b)
  let run = 0
  for (let i = 0; i < sortedDays.length; i++) {
    run = i > 0 && sortedDays[i] === sortedDays[i - 1] + 1 ? run + 1 : 1
    if (run > longestStreak) longestStreak = run
  }

  // 14-day sparkline with weekday labels — turns plus tokens processed
  // (kind='tokens' events carry the per-turn context+output total in n).
  const tokRows = db
    .prepare("SELECT ts, n FROM events WHERE kind='tokens' AND ts >= ?")
    .all(startOfToday - 14 * dayMs) as { ts: number; n: number }[]
  const spark: { day: string; turns: number; tokens: number }[] = []
  for (let i = 13; i >= 0; i--) {
    const d = today - i
    spark.push({
      day: new Date((d + 1) * dayMs + tzOffMs - 1).toLocaleDateString(undefined, {
        weekday: 'narrow'
      }),
      turns: turns.filter((e) => dayOf(e.ts) === d).length,
      tokens: tokRows.filter((r) => dayOf(r.ts) === d).reduce((s, r) => s + r.n, 0)
    })
  }

  // Attention per project — 7 days and all-time.
  const wsNames = new Map(
    (db.prepare('SELECT id, name FROM workspaces').all() as { id: string; name: string }[]).map(
      (w) => [w.id, w.name]
    )
  )
  const tally = (list: Entry[]): { name: string; turns: number }[] => {
    const m = new Map<string, number>()
    for (const e of list) {
      const name = (e.ws && wsNames.get(e.ws)) || null
      if (name) m.set(name, (m.get(name) ?? 0) + 1)
    }
    return [...m.entries()]
      .map(([name, n]) => ({ name, turns: n }))
      .sort((a, b) => b.turns - a.turns)
  }
  const attention = tally(turns.filter((e) => now - e.ts <= 7 * dayMs)).slice(0, 8)
  const attentionAll = tally(turns).slice(0, 5)

  // Busiest hours (turns by hour-of-day, last 30 days).
  const hours = new Array<number>(24).fill(0)
  for (const e of turns) {
    if (now - e.ts <= 30 * dayMs) hours[new Date(e.ts).getHours()] += 1
  }

  // Busiest single day ever.
  let busiestDay: { date: string; turns: number } | null = null
  for (const d of days) {
    const n = turns.filter((e) => dayOf(e.ts) === d).length
    if (!busiestDay || n > busiestDay.turns)
      busiestDay = {
        date: new Date((d + 1) * dayMs + tzOffMs - 1).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric'
        }),
        turns: n
      }
  }

  const tokensTotal = (
    db.prepare("SELECT COALESCE(SUM(n),0) t FROM events WHERE kind='tokens'").get() as {
      t: number
    }
  ).t
  const chatCount = (db.prepare('SELECT COUNT(*) n FROM chats').get() as { n: number }).n
  const projectCount = (db.prepare('SELECT COUNT(*) n FROM workspaces').get() as { n: number }).n

  // Average turns per active day over the last 30.
  const recentDays = sortedDays.filter((d) => d > today - 30)
  const recentTurns = turns.filter((e) => now - e.ts <= 30 * dayMs).length
  const avgTurns30 = recentDays.length ? Math.round((recentTurns / recentDays.length) * 10) / 10 : 0

  // reduce, not Math.min(...spread) — a years-deep transcript history can
  // exceed the engine's argument limit and throw.
  const firstTs = turns.length ? turns.reduce((m, e) => (e.ts < m ? e.ts : m), Infinity) : null

  return {
    turnsToday,
    tasksToday,
    streak,
    longestStreak,
    spark,
    attention,
    attentionAll,
    hours,
    busiestDay,
    avgTurns30,
    firstTs,
    totals: {
      turns: turns.length,
      tasks: tasksTotal,
      chats: chatCount,
      projects: projectCount,
      messages: totalMessages,
      tokens: tokensTotal
    }
  }
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
    // Reassign this group's projects to the next group (by position) so they're
    // never orphaned — deleting a group must not lose projects.
    const other = db
      .prepare('SELECT id FROM groups WHERE id != ? ORDER BY position LIMIT 1')
      .get(id) as { id: string } | undefined
    const tx = db.transaction(() => {
      if (other) db.prepare('UPDATE workspaces SET groupId = ? WHERE groupId = ?').run(other.id, id)
      db.prepare('DELETE FROM groups WHERE id = ?').run(id)
    })
    tx()
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

  // A project holds many chats; each owns its transcript and its resumable
  // claude session, so starting a new one never discards an old one.
  ipcMain.handle('chat:list', (_e, workspaceId: string) =>
    db
      .prepare(
        `SELECT id, workspaceId, title, claudeSessionId, updatedAt, cwd
         FROM chats WHERE workspaceId = ? ORDER BY position ASC, updatedAt ASC`
      )
      .all(workspaceId)
  )
  // Every chat in one query — the sidebar lists conversations for projects that
  // aren't open, so it can't wait for each WorkspaceView to mount.
  ipcMain.handle('chat:listAll', () =>
    db
      .prepare(
        `SELECT id, workspaceId, title, claudeSessionId, updatedAt, cwd
         FROM chats ORDER BY workspaceId, position ASC, updatedAt ASC`
      )
      .all()
  )
  ipcMain.on('events:record', (_e, kind: string, workspaceId?: string, n?: number) =>
    recordEvent(kind, workspaceId, n)
  )
  ipcMain.handle('events:dashboard', () => getDashboard())

  ipcMain.handle('chat:create', (_e, workspaceId: string, cwd?: string) => {
    const id = randomUUID()
    const next =
      ((
        db
          .prepare('SELECT MAX(position) AS p FROM chats WHERE workspaceId = ?')
          .get(workspaceId) as { p: number | null } | undefined
      )?.p ?? -1) + 1
    db.prepare(
      'INSERT INTO chats (id, workspaceId, title, claudeSessionId, position, updatedAt, data, cwd) VALUES (?, ?, NULL, NULL, ?, ?, ?, ?)'
    ).run(id, workspaceId, next, Date.now(), '[]', cwd ?? null)
    return id
  })
  ipcMain.handle('chat:delete', (_e, id: string) => {
    db.prepare('DELETE FROM chats WHERE id = ?').run(id)
  })
  ipcMain.handle(
    'chat:update',
    (_e, id: string, patch: { title?: string | null; claudeSessionId?: string | null }) => {
      const sets: string[] = []
      const vals: (string | number | null)[] = []
      for (const key of ['title', 'claudeSessionId'] as const) {
        if (key in patch) {
          sets.push(`${key} = ?`)
          vals.push(patch[key] ?? null)
        }
      }
      if (!sets.length) return
      vals.push(id)
      db.prepare(`UPDATE chats SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
    }
  )

  ipcMain.handle('chat:load', (_e, chatId: string) => {
    const row = db.prepare('SELECT data FROM chats WHERE id = ?').get(chatId) as
      { data: string } | undefined
    return row?.data ?? null
  })
  ipcMain.on('chat:save', (_e, chatId: string, data: string) => {
    // UPDATE (never INSERT) and only for a real id: a save for an unknown chat is
    // a caller bug, and must not be able to invent a row or clobber another's.
    if (!chatId) return
    db.prepare('UPDATE chats SET data = ?, updatedAt = ? WHERE id = ?').run(
      data,
      Date.now(),
      chatId
    )
  })
  // Wipes one chat's transcript in place (used by Retry-style resets), which is
  // no longer how "New chat" works — that creates a sibling instead.
  ipcMain.on('chat:clear', (_e, chatId: string) => {
    db.prepare("UPDATE chats SET data = '[]', claudeSessionId = NULL WHERE id = ?").run(chatId)
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

  ipcMain.handle('store:moveGroup', (_e, groupId: string, toIndex: number) => {
    const order = (
      db.prepare('SELECT id FROM groups WHERE id != ? ORDER BY position').all(groupId) as {
        id: string
      }[]
    ).map((g) => g.id)
    order.splice(Math.max(0, Math.min(toIndex, order.length)), 0, groupId)
    const tx = db.transaction(() => {
      order.forEach((id, i) => db.prepare('UPDATE groups SET position = ? WHERE id = ?').run(i, id))
    })
    tx()
    return getTree()
  })
}
