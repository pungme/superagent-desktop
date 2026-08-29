import { ipcMain, BrowserWindow, Notification, powerMonitor } from 'electron'
import { spawn } from 'child_process'
import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { ensureOffscreenPane, destroyBrowserPane } from './browser'
import { navigate } from './automation'
import { writeWorkspaceMcpConfig } from './mcp'
import { getHookUrl } from './hooks'
import { getDb, getWorkspaceKind } from './store'
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
const RUN_TIMEOUT_MS = 8 * 60 * 1000
const MAX_TURNS = 50

// Routine runs are headless with no user watching. Steer the agent to act
// directly and stop re-verifying — obsessive re-checks used to burn the whole
// turn budget before the task finished (so it ended with no summary → "error").
const ROUTINE_SYSTEM_PROMPT =
  'You are running as an automated background routine in SuperAgent — headless, with no user ' +
  'watching. Work efficiently and finish within your turn budget: take the needed actions directly, ' +
  'and verify results at most once. Do NOT repeatedly re-read the page or re-check state after each ' +
  'step. When the task is done (or as done as it can be), stop and end with a one-line summary of ' +
  'what you accomplished (e.g. "Followed 5 accounts").'

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
  lastRunTranscript: string | null
  runCount: number
  lastRunTokens: number
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
  // Added later: the last run's transcript (thinking + tool calls + text), stored
  // as a JSON RoutineStep[] so the user can inspect what a routine actually did.
  const cols = db.prepare('PRAGMA table_info(routines)').all() as { name: string }[]
  if (!cols.some((c) => c.name === 'lastRunTranscript')) {
    db.exec('ALTER TABLE routines ADD COLUMN lastRunTranscript TEXT')
  }
  // Total times this routine has run (shown in the UI).
  if (!cols.some((c) => c.name === 'runCount')) {
    db.exec('ALTER TABLE routines ADD COLUMN runCount INTEGER NOT NULL DEFAULT 0')
    // A routine that already has a last run has run at least once — don't show "0 runs".
    db.exec('UPDATE routines SET runCount = 1 WHERE lastRunAt IS NOT NULL')
  }
  // Tokens the last run used (input + output + cache), shown in the run viewer.
  if (!cols.some((c) => c.name === 'lastRunTokens')) {
    db.exec('ALTER TABLE routines ADD COLUMN lastRunTokens INTEGER NOT NULL DEFAULT 0')
  }
}

/** One entry in a routine run's transcript. */
export type RoutineStep =
  | { kind: 'thinking'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'tool'; name: string; input?: string }

/** Pull the readable steps out of one stream-json `assistant` event. */
function stepsFromAssistant(event: {
  message?: { content?: Array<Record<string, unknown>> }
}): RoutineStep[] {
  const content = event.message?.content
  if (!Array.isArray(content)) return []
  const steps: RoutineStep[] = []
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      steps.push({ kind: 'text', text: block.text })
    } else if (
      block.type === 'thinking' &&
      typeof block.thinking === 'string' &&
      block.thinking.trim()
    ) {
      steps.push({ kind: 'thinking', text: block.thinking })
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      // Strip the mcp__cove-browser__ prefix so the tool reads as e.g. "browser_navigate".
      const name = block.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, '')
      let input: string | undefined
      try {
        input = block.input ? JSON.stringify(block.input).slice(0, 200) : undefined
      } catch {
        input = undefined
      }
      steps.push({ kind: 'tool', name, input })
    }
  }
  return steps
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
  // Reset the transcript/summary so the live viewer starts fresh for this run
  // (steps are streamed in below as they arrive, not just written at the end).
  db.prepare(
    'UPDATE routines SET lastRunStatus = ?, lastRunAt = ?, lastRunTranscript = ?, lastRunSummary = ? WHERE id = ?'
  ).run('running', nowMs(), '[]', null, routine.id)
  broadcast()

  // Offscreen pane sharing the workspace's cookies, scoped MCP config for it.
  const paneId = routinePaneId(routine.workspaceId)
  let result: { ok: boolean; summary: string; steps: RoutineStep[]; tokens: number } = {
    ok: false,
    summary: 'Run failed to start.',
    steps: [],
    tokens: 0
  }

  try {
    const win = BrowserWindow.getAllWindows()[0]
    // Match the visible pane's partition (shared for browser projects) so the
    // routine runs against the same logged-in session the user set up by hand.
    if (win)
      ensureOffscreenPane(
        win,
        paneId,
        partitionFor(routine.workspaceId, getWorkspaceKind(routine.workspaceId))
      )
    // Seed the offscreen pane with the project's last-viewed URL so the agent has a
    // real page to act on. Without this it starts on about:blank, so a prompt like
    // "refresh the Instagram page and follow 5 people" has no page — the agent reads
    // blank and stalls. Best-effort: if it fails, the agent can still navigate itself.
    const wsRow = db
      .prepare('SELECT browserUrl FROM workspaces WHERE id = ?')
      .get(routine.workspaceId) as { browserUrl?: string } | undefined
    if (wsRow?.browserUrl) {
      try {
        await navigate(paneId, wsRow.browserUrl)
      } catch {
        // ignore — the routine prompt can still drive navigation
      }
    }
    const mcpConfig = writeWorkspaceMcpConfig(paneId)

    result = await new Promise<{
      ok: boolean
      summary: string
      steps: RoutineStep[]
      tokens: number
    }>((resolve) => {
      const proc = spawn(
        findClaude(),
        [
          '-p',
          routine.prompt,
          // stream-json (not plain json) so we capture the thinking + tool calls as
          // they happen, for the run transcript the user can inspect.
          '--output-format',
          'stream-json',
          '--verbose',
          '--append-system-prompt',
          ROUTINE_SYSTEM_PROMPT,
          '--mcp-config',
          mcpConfig,
          // The full cove-browser tool set. Omissions bite: a routine that tried
          // browser_evaluate to verify its work got every call denied and looped
          // until it timed out. Keep this in sync with the tools mcp.ts registers.
          '--allowedTools',
          'mcp__cove-browser__browser_navigate',
          'mcp__cove-browser__browser_read_page',
          'mcp__cove-browser__browser_click',
          'mcp__cove-browser__browser_type',
          'mcp__cove-browser__browser_press_key',
          'mcp__cove-browser__browser_screenshot',
          'mcp__cove-browser__browser_evaluate',
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

      const steps: RoutineStep[] = []
      let summary = '(no summary)'
      let isError = false
      let tokens = 0
      let buffer = ''
      // Stream steps to the DB as they arrive so the run viewer updates live —
      // otherwise a headless run looks like nothing is happening for minutes.
      const persistSteps = (): void => {
        try {
          db.prepare('UPDATE routines SET lastRunTranscript = ? WHERE id = ?').run(
            JSON.stringify(steps),
            routine.id
          )
          broadcast()
        } catch {
          // a transient DB error mustn't kill the run
        }
      }
      const consume = (chunk: string): void => {
        buffer += chunk
        let nl: number
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim()
          buffer = buffer.slice(nl + 1)
          if (!line) continue
          try {
            const event = JSON.parse(line)
            if (event?.type === 'assistant') {
              const added = stepsFromAssistant(event)
              if (added.length) {
                steps.push(...added)
                persistSteps()
              }
            } else if (event?.type === 'result') {
              if (typeof event.result === 'string' && event.result.trim()) {
                summary = event.result.slice(0, 500)
              }
              isError = event.is_error === true
              const u = event.usage
              if (u && typeof u === 'object') {
                tokens =
                  (u.input_tokens ?? 0) +
                  (u.output_tokens ?? 0) +
                  (u.cache_creation_input_tokens ?? 0) +
                  (u.cache_read_input_tokens ?? 0)
              }
            }
          } catch {
            // partial or non-JSON line; ignore
          }
        }
      }

      const timer = setTimeout(() => {
        proc.kill()
        resolve({
          ok: false,
          summary: `Timed out after ${Math.round(RUN_TIMEOUT_MS / 60000)} minutes.`,
          steps,
          tokens
        })
      }, RUN_TIMEOUT_MS)

      proc.stdin.on('error', () => {})
      proc.stdout.on('data', (c) => consume(c.toString()))
      proc.on('error', (e) => {
        clearTimeout(timer)
        resolve({ ok: false, summary: `Failed to launch: ${e.message}`, steps, tokens })
      })
      proc.on('exit', () => {
        clearTimeout(timer)
        resolve({ ok: !isError, summary, steps, tokens })
      })
    })
  } catch (e) {
    result = {
      ok: false,
      summary: `Run failed to start: ${(e as Error).message}`,
      steps: [],
      tokens: 0
    }
  } finally {
    // Release the lock first so the routine can never wedge in "running" and stop
    // rescheduling, even if a later cleanup step throws.
    running.delete(routine.id)
    db.prepare(
      'UPDATE routines SET lastRunStatus = ?, lastRunSummary = ?, lastRunTranscript = ?, lastRunAt = ?, nextRunAt = ?, runCount = runCount + 1, lastRunTokens = ? WHERE id = ?'
    ).run(
      result.ok ? 'ok' : 'error',
      result.summary,
      JSON.stringify(result.steps),
      nowMs(),
      nowMs() + routine.intervalMs,
      result.tokens,
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
  // Prune orphans: a routine whose workspace no longer exists (the project was
  // deleted before routines were cleaned up on delete). Left alone it runs
  // forever, invisible in the UI, driving the browser in the background — which
  // read as "an agent keeps running though I have no routines".
  db.prepare('DELETE FROM routines WHERE workspaceId NOT IN (SELECT id FROM workspaces)').run()
  // No run can survive an app restart (the in-memory `running` set and the child
  // process are both gone), so any routine still marked "running" is stale — clear
  // it, or its Run button and status would look wedged forever.
  db.prepare(
    "UPDATE routines SET lastRunStatus = 'error', lastRunSummary = ? WHERE lastRunStatus = 'running'"
  ).run('Interrupted — the app restarted mid-run.')
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
    (_e, workspaceId: string, workspacePath: string, prompt: string, intervalMinutes: number) => {
      const r = createRoutine(workspaceId, workspacePath, prompt, intervalMinutes * 60 * 1000)
      broadcast() // keep the sidebar tree + any open panel in sync
      return r
    }
  )
  ipcMain.handle('routines:setEnabled', (_e, id: string, enabled: boolean) => {
    setRoutineEnabled(id, enabled)
    broadcast()
    return listRoutines()
  })
  ipcMain.handle('routines:delete', (_e, id: string) => {
    deleteRoutine(id)
    broadcast()
    return listRoutines()
  })
  ipcMain.on('routines:runNow', (_e, id: string) => {
    const r = db.prepare('SELECT * FROM routines WHERE id = ?').get(id) as Routine | undefined
    if (r) runRoutine(r).catch(() => {})
  })
}
