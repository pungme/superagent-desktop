import { describe, it, expect, vi } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const h = vi.hoisted(() => ({ db: null as unknown as import('better-sqlite3').Database }))
vi.mock('electron', () => ({
  app: { getPath: () => '/nonexistent' },
  ipcMain: { handle: vi.fn() }
}))
vi.mock('./store', () => ({ getDb: () => h.db }))
vi.mock('./agent', () => ({ killAllAgents: vi.fn() }))
vi.mock('./loops', () => ({ _resetLoopsForTests: vi.fn() }))
vi.mock('./external-browser', () => ({ closeExternalBrowsers: vi.fn() }))

import { wipeAppData } from './reset'

describe('Reset Superagent', () => {
  it('clears the work, keeps phones, browser logins, beta choice and every file', () => {
    h.db = new Database(':memory:')
    for (const t of [
      'groups',
      'workspaces',
      'chats',
      'chat_events',
      'events',
      'history',
      'queued_sends',
      'cards',
      'routines',
      'calendar_events',
      'devices'
    ]) {
      h.db.exec(`CREATE TABLE ${t} (id TEXT)`)
      h.db.prepare(`INSERT INTO ${t} VALUES ('x')`).run()
    }
    h.db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT)')
    for (const k of ['cove.betaUpdates', 'cove.partitions-merged', 'activeWorkspace', 'browser:w1'])
      h.db.prepare('INSERT INTO kv VALUES (?, ?)').run(k, '1')

    const data = mkdtempSync(join(tmpdir(), 'sa-reset-'))
    mkdirSync(join(data, 'attachments'))
    writeFileSync(join(data, 'attachments', 'pic.jpg'), 'x')
    writeFileSync(join(data, 'mcp-w1-c1.json'), '{}')
    mkdirSync(join(data, 'browsers', 'brave'), { recursive: true })
    mkdirSync(join(data, 'companion'))
    writeFileSync(join(data, 'companion', 'identity.bin'), 'x')
    mkdirSync(join(data, 'browser-projects', 'w1'), { recursive: true })

    wipeAppData(data)

    const count = (t: string): number =>
      (h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n
    for (const t of ['groups', 'workspaces', 'chats', 'chat_events', 'cards', 'routines'])
      expect(count(t)).toBe(0)
    expect(count('devices')).toBe(1)
    expect(
      (h.db.prepare('SELECT key FROM kv ORDER BY key').all() as { key: string }[]).map((r) => r.key)
    ).toEqual(['cove.betaUpdates', 'cove.partitions-merged'])
    expect(readdirSync(data).sort()).toEqual(['browser-projects', 'browsers', 'companion'])
    expect(existsSync(join(data, 'companion', 'identity.bin'))).toBe(true)
  })
})
