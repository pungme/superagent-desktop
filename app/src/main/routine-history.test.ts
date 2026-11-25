import { describe, it, expect, beforeEach, vi } from 'vitest'
import Database from 'better-sqlite3'

/**
 * The routine overview's data: a run history per routine, and changing a
 * routine in place. Against a real in-memory database with the real schema code.
 */
const h = vi.hoisted(() => ({ db: null as unknown }))

vi.mock('electron', () => ({
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
  powerMonitor: { on: () => undefined }
}))
vi.mock('./browser', () => ({
  ensureOffscreenPane: () => undefined,
  destroyBrowserPane: () => undefined
}))
vi.mock('./automation', () => ({ navigate: async () => undefined }))
vi.mock('./mcp', () => ({ writeWorkspaceMcpConfig: () => '', workspaceMcpUrl: () => '' }))
vi.mock('./store', () => ({ getDb: () => h.db, kvGet: () => null }))
vi.mock('./claude/routine', () => ({
  runClaudeRoutine: async () => ({
    ok: true,
    summary: 'Followed 5 accounts',
    steps: [],
    tokens: 12_000
  })
}))
vi.mock('./codex/routine', () => ({ runCodexRoutine: async () => ({}) }))
vi.mock('./antigravity/routine', () => ({ runAntigravityRoutine: async () => ({}) }))
vi.mock('./util', () => ({
  broadcastToWindows: () => undefined,
  SHARED_BROWSER_PARTITION: 'p',
  routinePaneId: (id: string) => `routine-${id}`
}))

const r = await import('./routines')

const HOUR = 3_600_000

function fresh(): Database.Database {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY, path TEXT, browserUrl TEXT)')
  db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, workspaceId TEXT)')
  db.exec('CREATE TABLE chat_events (chatId TEXT, kind TEXT, data TEXT)')
  db.prepare("INSERT INTO workspaces (id, path) VALUES ('w1', '/tmp/w1')").run()
  h.db = db
  return db
}

describe('routine history and editing', () => {
  let db: Database.Database
  beforeEach(() => {
    db = fresh()
    r.startRoutines()
    r.stopRoutines()
  })

  const make = (prompt = 'Update the metrics sheet'): string =>
    r.createRoutine('w1', '/tmp/w1', prompt, HOUR).id

  it('records every run with its tokens and summary', async () => {
    const id = make()
    const routine = r.listRoutines('w1')[0]
    await r.runRoutine(routine)
    await r.runRoutine(r.listRoutines('w1')[0])
    const runs = r.listRoutineRuns(id)
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ status: 'ok', tokens: 12_000, summary: 'Followed 5 accounts' })
    expect(runs[0].endedAt).not.toBeNull()
  })

  it('keeps only the latest runs of a routine', async () => {
    const id = make()
    const ins = db.prepare(
      "INSERT INTO routine_runs (id, routineId, startedAt, endedAt, status, tokens) VALUES (?, ?, ?, ?, 'ok', 1)"
    )
    for (let i = 0; i < r.RUNS_KEPT + 5; i++) ins.run(`old${i}`, id, i + 1, i + 1)
    await r.runRoutine(r.listRoutines('w1')[0])
    const runs = r.listRoutineRuns(id, 500)
    expect(runs).toHaveLength(r.RUNS_KEPT)
    // The oldest went; the run that just finished is the newest.
    expect(runs.some((x) => x.id === 'old0')).toBe(false)
    expect(runs[0].summary).toBe('Followed 5 accounts')
  })

  it('lists every routine’s runs together when no routine is named', async () => {
    make('one')
    make('two')
    for (const routine of r.listRoutines('w1')) await r.runRoutine(routine)
    expect(r.listRoutineRuns().length).toBe(2)
  })

  it('a routine that ran before the history keeps its last run in it', () => {
    const id = make()
    db.exec('DELETE FROM routine_runs')
    db.prepare(
      "UPDATE routines SET lastRunAt = 1000, lastRunStatus = 'error', lastRunSummary = 'boom', lastRunTokens = 7 WHERE id = ?"
    ).run(id)
    r.startRoutines()
    r.stopRoutines()
    expect(r.listRoutineRuns(id)).toMatchObject([{ status: 'error', summary: 'boom', tokens: 7 }])
  })

  it('a run cut short by a restart ends as an error, not as running forever', () => {
    const id = make()
    db.prepare(
      "INSERT INTO routine_runs (id, routineId, startedAt, status) VALUES ('x', ?, 5, 'running')"
    ).run(id)
    r.startRoutines()
    r.stopRoutines()
    expect(r.listRoutineRuns(id).find((x) => x.id === 'x')).toMatchObject({
      status: 'error',
      summary: expect.stringContaining('Interrupted')
    })
  })

  it('deleting a routine deletes its history', async () => {
    const id = make()
    await r.runRoutine(r.listRoutines('w1')[0])
    r.deleteRoutine(id)
    expect(r.listRoutineRuns(id)).toEqual([])
  })

  describe('updateRoutine', () => {
    it('changes the prompt', () => {
      const id = make()
      expect(r.updateRoutine(id, { prompt: '  Only fetch the new rows  ' })).toBe(true)
      expect(r.listRoutines('w1')[0].prompt).toBe('Only fetch the new rows')
    })

    it('refuses an empty prompt and an unknown routine', () => {
      const id = make()
      expect(r.updateRoutine(id, { prompt: '   ' })).toBe(false)
      expect(r.listRoutines('w1')[0].prompt).toBe('Update the metrics sheet')
      expect(r.updateRoutine('nope', { prompt: 'x' })).toBe(false)
    })

    it('slowing a routine down counts from now, and keeps the 60-minute floor', () => {
      const id = make()
      const before = Date.now()
      r.updateRoutine(id, { intervalMs: 6 * HOUR })
      let row = r.listRoutines('w1')[0]
      expect(row.intervalMs).toBe(6 * HOUR)
      expect(row.nextRunAt).toBeGreaterThanOrEqual(before + 6 * HOUR)
      r.updateRoutine(id, { intervalMs: 60_000 })
      row = r.listRoutines('w1')[0]
      expect(row.intervalMs).toBe(HOUR)
    })

    it('leaves the schedule alone when the interval did not change', () => {
      const id = make()
      const next = r.listRoutines('w1')[0].nextRunAt
      r.updateRoutine(id, { prompt: 'new words', intervalMs: HOUR })
      expect(r.listRoutines('w1')[0].nextRunAt).toBe(next)
    })

    it('ignores a nonsense interval', () => {
      const id = make()
      r.updateRoutine(id, { intervalMs: Number.NaN })
      expect(r.listRoutines('w1')[0].intervalMs).toBe(HOUR)
    })
  })
})
