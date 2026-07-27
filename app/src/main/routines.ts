import { ipcMain, BrowserWindow, Notification, powerMonitor } from 'electron'
import { spawn } from 'child_process'
import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { ensureOffscreenPane, destroyBrowserPane } from './browser'
import { writeWorkspaceMcpConfig } from './mcp'
import { getHookUrl } from './hooks'
import { getDb } from './store'
import { findClaude } from './claude-cli'
import { broadcastToWindows, partitionFor, routinePaneId } from './util'

/**
 * Routines — scheduled natural-language browser tasks.
 * "Check my site every hour" typed once, run on a local ticker.
 *
 * Design (from the servus-ai learnings, adapted to SuperAgent + Claude):
 *  - the NL prompt IS the stored artifact, re-planned fresh each run
 *  - a 60s main-process ticker (survives renderer reloads), one catch-up run max
 *  - each run = headless `claude -p` scoped to an offscreen browser pane that
 *    shares the workspace's cookies, so scheduled runs never steal the viewport
 *  - guardrails: wall-clock timeout + max turns
 *  - honest limit: only runs while SuperAgent is open (session cookies are local)
 */

export const MIN_INTERVAL_MS = 60 * 60 * 1000 // 60 minutes — enforced floor
const RUN_TIMEOUT_MS = 5 * 60 * 1000
const MAX_TURNS = 30

/** Clamp a requested interval to the 60-minute floor. Pure — unit tested. */
export function flooredInterval(ms: number): number {
  return Math.max(MIN_INTERVAL_MS, ms)
}

export interface Routine {
  id: string
  workspaceId: string
  workspacePath: string
  prompt: string
  intervalMs: number
  enabled: number
  nextRunAt: number
  lastRunAt: number | null
  lastRunStatus: 'ok' | 'error' | 'running' | null
  lastRunSummary: string | null
}

let db: Database.Database
let ticker: ReturnType<typeof setInterval> | null = null
const running = new Set<string>()

function initDb(): void {
  // Reuse the shared connection opened by the store (no second handle on cove.db).
  db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS routines (
      id TEXT PRIMARY KEY,
      workspaceId TEXT NOT NULL,
      workspacePath TEXT NOT NULL,
      prompt TEXT NOT NULL,
      intervalMs INTEGER NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      nextRunAt INTEGER NOT NULL,
      lastRunAt INTEGER,
      lastRunStatus TEXT,
      lastRunSummary TEXT
    );
  `)
}

export function listRoutines(workspaceId?: string): Routine[] {
  const rows = workspaceId
    ? db.prepare('SELECT * FROM routines WHERE workspaceId = ? ORDER BY nextRunAt').all(workspaceId)
    : db.prepare('SELECT * FROM routines ORDER BY nextRunAt').all()
  return rows as Routine[]
}

export function createRoutine(
  workspaceId: string,
  workspacePath: string,
  prompt: string,
  intervalMs: number
): Routine {
  const id = randomUUID()
  const interval = flooredInterval(intervalMs)
  const now = nowMs()
  db.prepare(
    `INSERT INTO routines (id, workspaceId, workspacePath, prompt, intervalMs, enabled, nextRunAt, lastRunAt, lastRunStatus, lastRunSummary)
     VALUES (?, ?, ?, ?, ?, 1, ?, NULL, NULL, NULL)`
  ).run(id, workspaceId, workspacePath, prompt, interval, now + interval)
  return db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Routine
}

/** Create a routine for a workspace, looking up its path. Used by the create_routine MCP tool. */
export function createRoutineForWorkspace(
  workspaceId: string,
  prompt: string,
  intervalMinutes: number
): { ok: boolean; message: string } {
  const ws = db.prepare('SELECT path FROM workspaces WHERE id = ?').get(workspaceId) as
    { path: string } | undefined
  if (!ws) return { ok: false, message: `Unknown workspace ${workspaceId}` }
  const requestedMs = intervalMinutes * 60 * 1000
  createRoutine(workspaceId, ws.path, prompt, requestedMs)
  broadcast()
  const floored = requestedMs < MIN_INTERVAL_MS
  return {
    ok: true,
    message: floored
      ? `Created a routine that runs every 60 minutes (the minimum). It only runs while SuperAgent is open.`
      : `Created a routine that runs every ${intervalMinutes} minutes. It only runs while SuperAgent is open.`
  }
}

export function setRoutineEnabled(id: string, enabled: boolean): void {
  db.prepare('UPDATE routines SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
}

export function deleteRoutine(id: string): void {
  db.prepare('DELETE FROM routines WHERE id = ?').run(id)
}

// Date.now() is fine in the Electron main process (only workflow scripts forbid it).
function nowMs(): number {
  return Date.now()
}

function notify(title: string, body: string): void {
  if (Notification.isSupported()) new Notification({ title, body }).show()
}

function broadcast(): void {
  broadcastToWindows('routines:changed')
}

export async function runRoutine(routine: Routine): Promise<void> {
  if (running.has(routine.id)) return
  running.add(routine.id)
  db.prepare('UPDATE routines SET lastRunStatus = ?, lastRunAt = ? WHERE id = ?').run(
    'running',
    nowMs(),
    routine.id
  )
  broadcast()

  // Offscreen pane sharing the workspace's cookies, scoped MCP config for it.
  const paneId = routinePaneId(routine.workspaceId)
  let result: { ok: boolean; summary: string } = {
    ok: false,
    summary: 'Run failed to start.'
  }

  try {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) ensureOffscreenPane(win, paneId, partitionFor(routine.workspaceId))
    const mcpConfig = writeWorkspaceMcpConfig(paneId)

    result = await new Promise<{ ok: boolean; summary: string }>((resolve) => {
      const proc = spawn(
        findClaude(),
        [
          '-p',
          routine.prompt,
          '--output-format',
          'json',
          '--mcp-config',
          mcpConfig,
          '--allowedTools',
          'mcp__cove-browser__browser_navigate',
          'mcp__cove-browser__browser_read_page',
          'mcp__cove-browser__browser_click',
          'mcp__cove-browser__browser_type',
          'mcp__cove-browser__browser_screenshot',
          'mcp__cove-browser__browser_console',
          'mcp__cove-browser__browser_network',
          'mcp__cove-browser__browser_wait_for',
          '--max-turns',
          String(MAX_TURNS)
        ],
        {
          cwd: routine.workspacePath,
          env: {
            ...process.env,
            COVE_HOOK_URL: getHookUrl(),
            COVE_WORKSPACE_ID: paneId
          }
        }
      )

      let out = ''
      const timer = setTimeout(() => {
        proc.kill()
        resolve({ ok: false, summary: 'Timed out after 5 minutes.' })
      }, RUN_TIMEOUT_MS)

      proc.stdin.on('error', () => {})
      proc.stdout.on('data', (c) => (out += c.toString()))
      proc.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, summary: `Failed to launch: ${e.message}` })
      })
      proc.on('exit', () => {
        clearTimeout(timer)
        try {
          const json = JSON.parse(out)
          const summary = (json.result || '(no summary)').toString().slice(0, 500)
          resolve({ ok: json.is_error !== true, summary })
        } catch {
          resolve({ ok: false, summary: 'Could not parse the run result.' })
        }
      })
    })
  } catch (e) {
    result = { ok: false, summary: `Run failed to start: ${(e as Error).message}` }
  } finally {
    // Release the lock first so the routine can never wedge in "running" and stop
    // rescheduling, even if a later cleanup step throws.
    running.delete(routine.id)
    db.prepare(
      'UPDATE routines SET lastRunStatus = ?, lastRunSummary = ?, lastRunAt = ?, nextRunAt = ? WHERE id = ?'
    ).run(
      result.ok ? 'ok' : 'error',
      result.summary,
      nowMs(),
      nowMs() + routine.intervalMs,
      routine.id
    )
    // Free the offscreen WebContentsView (cookies live in the partition, not the
    // pane, so login persists); the next run recreates it on demand.
    destroyBrowserPane(paneId)
    broadcast()
  }

  if (!result.ok) {
    notify('SuperAgent routine failed', result.summary.slice(0, 120))
  }
}

function tick(): void {
  const now = nowMs()
  const due = db
    .prepare('SELECT * FROM routines WHERE enabled = 1 AND nextRunAt <= ?')
    .all(now) as Routine[]
  for (const routine of due) {
    // One catch-up run max: nextRunAt advances inside runRoutine, missed slots dropped.
    runRoutine(routine).catch(() => {})
  }
}

export function startRoutines(): void {
  initDb()
  // On launch, pull any overdue routine to exactly one catch-up run (drop the backlog).
  const now = nowMs()
  const overdue = db
    .prepare('SELECT id, intervalMs FROM routines WHERE enabled = 1 AND nextRunAt < ?')
    .all(now - 5000) as { id: string; intervalMs: number }[]
  for (const r of overdue) {
    // Schedule the catch-up run one tick out rather than firing them all at boot.
    db.prepare('UPDATE routines SET nextRunAt = ? WHERE id = ?').run(now + 5000, r.id)
  }

  ticker = setInterval(tick, 60 * 1000)
  // Don't fire ticks while asleep; resume checks on wake.
  powerMonitor.on('resume', () => tick())
}

export function stopRoutines(): void {
  if (ticker) clearInterval(ticker)
  ticker = null
}

export function registerRoutinesIpc(): void {
  ipcMain.handle('routines:list', (_e, workspaceId?: string) => listRoutines(workspaceId))
  ipcMain.handle(
    'routines:create',
    (_e, workspaceId: string, workspacePath: string, prompt: string, intervalMinutes: number) =>
      createRoutine(workspaceId, workspacePath, prompt, intervalMinutes * 60 * 1000)
  )
  ipcMain.handle('routines:setEnabled', (_e, id: string, enabled: boolean) => {
    setRoutineEnabled(id, enabled)
    return listRoutines()
  })
  ipcMain.handle('routines:delete', (_e, id: string) => {
    deleteRoutine(id)
    return listRoutines()
  })
  ipcMain.on('routines:runNow', (_e, id: string) => {
    const r = db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Routine | undefined
    if (r) runRoutine(r).catch(() => {})
  })
}
