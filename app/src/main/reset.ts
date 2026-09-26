import { app, ipcMain } from 'electron'
import { readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { getDb } from './store'
import { killAllAgents } from './agent'
import { _resetLoopsForTests as stopAllLoops } from './loops'
import { closeExternalBrowsers } from './external-browser'

/**
 * Settings → Reset Superagent: start fresh, as after a new install.
 *
 * Clears everything the app keeps about your work — projects, groups, chats and
 * their history, the Todo board, routines, the calendar, queued messages, and
 * every per-project UI memory in kv. Keeps what would be a chore to redo and
 * says nothing about your work: paired phones (the devices table and
 * companion/identity.bin), the agent browsers' profiles (browsers/) and the
 * built-in browser's cookies, and the beta-updates choice. Never touches the
 * user's files — nor the scratch folders Superagent made for browser projects
 * and the Computer chat, in case something wanted is in them.
 */

/** Tables that hold the user's work. Not `devices`: paired phones stay. */
const TABLES = [
  'chat_events',
  'events',
  'history',
  'queued_sends',
  'cards',
  'routines',
  'calendar_events',
  'chats',
  'workspaces',
  'groups'
]

/** kv keys that survive: a setting, and a one-time migration marker. */
const KEEP_KV = ['cove.betaUpdates', 'cove.partitions-merged']

export function wipeAppData(userData = app.getPath('userData')): void {
  stopAllLoops()
  killAllAgents()
  closeExternalBrowsers()
  const db = getDb()
  const existing = new Set(
    (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name)
  )
  db.transaction(() => {
    for (const t of TABLES) if (existing.has(t)) db.prepare(`DELETE FROM ${t}`).run()
    db.prepare(`DELETE FROM kv WHERE key NOT IN (${KEEP_KV.map(() => '?').join(', ')})`).run(
      ...KEEP_KV
    )
  })()
  // Pictures sent in chats, and the per-chat tool configs (rewritten on the next start).
  rmSync(join(userData, 'attachments'), { recursive: true, force: true })
  for (const f of readdirSync(userData))
    if (/^mcp-.*\.json$/.test(f)) rmSync(join(userData, f), { force: true })
}

export function registerResetIpc(): void {
  ipcMain.handle('app:reset', () => {
    wipeAppData()
    // Tests reload the window in place; everyone else gets a fresh start.
    if (process.env.COVE_E2E_NO_RELAUNCH === '1') return { ok: true }
    app.relaunch()
    app.exit(0)
    return { ok: true }
  })
}
