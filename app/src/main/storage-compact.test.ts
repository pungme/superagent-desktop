import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  BrowserWindow: class {
    loadURL(): Promise<void> {
      return Promise.resolve()
    }
    isDestroyed(): boolean {
      return false
    }
    destroy(): void {}
  }
}))

import { requestCompact, runPendingCompact, storeSpace, takeCompactResult } from './storage-compact'

let dir: string
const sql = (q: string): string =>
  execFileSync('/usr/bin/sqlite3', [join(dir, 'cove.db'), q], { encoding: 'utf8' })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cove-compact-'))
  // A store with a lot deleted from it: the pages stay inside the file as free space.
  sql(
    'PRAGMA journal_mode=WAL; CREATE TABLE t (v TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 4000) INSERT INTO t SELECT hex(randomblob(500)) FROM n; DELETE FROM t WHERE rowid % 4 != 0; PRAGMA wal_checkpoint(TRUNCATE);'
  )
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('compacting the conversation stores', () => {
  it('says how much free space a store holds', async () => {
    const [s] = await storeSpace(dir)
    expect(s.file).toBe('cove.db')
    expect(s.freeBytes).toBeGreaterThan(1_000_000)
  })
  it('does nothing unless it was asked for', async () => {
    const before = statSync(join(dir, 'cove.db')).size
    await runPendingCompact(dir)
    expect(statSync(join(dir, 'cove.db')).size).toBe(before)
    expect(takeCompactResult(dir)).toBeNull()
  })
  it('gives the free space back on the next start, keeps the data, and says what it did', async () => {
    const before = statSync(join(dir, 'cove.db')).size
    requestCompact(dir)
    await runPendingCompact(dir)
    const after = statSync(join(dir, 'cove.db')).size
    expect(after).toBeLessThan(before / 2)
    expect(sql('SELECT count(*) FROM t').trim()).toBe('1000')
    // Asked once, done once: the request is gone.
    expect(existsSync(join(dir, 'compact-on-start'))).toBe(false)
    const r = takeCompactResult(dir)!
    expect(r.after).toBeLessThan(r.before)
    expect(r.failed).toBeUndefined()
    expect(takeCompactResult(dir)).toBeNull()
    const [s] = await storeSpace(dir)
    expect(s.freeBytes).toBe(0)
  })
})
