import { app, webContents } from 'electron'
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { writeHeapSnapshot } from 'v8'
import { listSessions } from './agent'

/**
 * A trail of the main process's memory, and one heap snapshot if it runs away.
 *
 * 2026-10-06: main died after 43 hours with its JavaScript heap at the 4 GB
 * ceiling (V8 FatalProcessOutOfMemory, from the crash report). Nothing left on
 * disk said what had filled it, and it does not reproduce on demand: saving,
 * loading and scanning large transcripts, and a screenshot-heavy agent stream,
 * all leave the heap where it was. So leave breadcrumbs where it happens —
 * a line in userData/memory.log every few minutes, and, the first time the
 * heap passes SNAPSHOT_AT, a heap snapshot in userData/diagnostics that names
 * whatever is holding the memory.
 */

const SAMPLE_MS = 60_000
/** A line at least this often, however quiet things are. */
const LOG_EVERY_MS = 5 * 60_000
/** ...and at once when the heap has moved this much since the last line. */
const LOG_ON_CHANGE = 100 * 1024 * 1024
/**
 * Far above anything ordinary (a busy main sits near 50 MB) and far enough
 * below the 4 GB ceiling that writing the snapshot itself is safe.
 */
export const SNAPSHOT_AT = 1200 * 1024 * 1024
const KEEP_SNAPSHOTS = 1

export interface MemorySample {
  at: number
  heapUsed: number
}

export interface WatchState {
  loggedAt: number
  loggedHeap: number
  snapshotTaken: boolean
}

/** What one sample calls for. Pure, so the thresholds can be tested. */
export function memoryVerdict(
  sample: MemorySample,
  state: WatchState
): { log: boolean; snapshot: boolean } {
  const snapshot = !state.snapshotTaken && sample.heapUsed >= SNAPSHOT_AT
  const log =
    snapshot ||
    sample.at - state.loggedAt >= LOG_EVERY_MS ||
    Math.abs(sample.heapUsed - state.loggedHeap) >= LOG_ON_CHANGE
  return { log, snapshot }
}

const mb = (n: number): string => `${Math.round(n / 1048576)}M`

let rotated = false
function memoryLog(line: string): void {
  try {
    const file = join(app.getPath('userData'), 'memory.log')
    if (!rotated) {
      rotated = true
      try {
        if (statSync(file).size > 512 * 1024) renameSync(file, file + '.old')
      } catch {
        /* first run — no log yet */
      }
    }
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* logging must never break the app */
  }
}

function takeSnapshot(): string | null {
  try {
    const dir = join(app.getPath('userData'), 'diagnostics')
    mkdirSync(dir, { recursive: true })
    const old = readdirSync(dir)
      .filter((f) => f.endsWith('.heapsnapshot'))
      .sort()
    // Each is hundreds of megabytes: the newest ones are the ones worth having.
    for (const f of old.slice(0, Math.max(0, old.length - (KEEP_SNAPSHOTS - 1)))) {
      try {
        unlinkSync(join(dir, f))
      } catch {
        /* fine */
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    return writeHeapSnapshot(join(dir, `main-${stamp}.heapsnapshot`))
  } catch {
    return null
  }
}

/** A snapshot has been read, or never will be, by the time it is this old. */
export const SNAPSHOT_KEEP_MS = 7 * 24 * 3600 * 1000

/** The snapshots past keeping, by their age. Pure, so it can be tested. */
export function staleSnapshots(
  files: { name: string; mtimeMs: number }[],
  now: number,
  keepMs = SNAPSHOT_KEEP_MS
): string[] {
  return files
    .filter((f) => f.name.endsWith('.heapsnapshot') && now - f.mtimeMs > keepMs)
    .map((f) => f.name)
}

/**
 * Each snapshot is gigabytes, and nothing used to remove one: the one from
 * 2026-10-09 was 3.4 GB of the 4.1 GB the app kept on disk, long after the
 * fault it recorded was fixed.
 */
function pruneSnapshots(): void {
  try {
    const dir = join(app.getPath('userData'), 'diagnostics')
    const files = readdirSync(dir).map((name) => ({
      name,
      mtimeMs: statSync(join(dir, name)).mtimeMs
    }))
    for (const name of staleSnapshots(files, Date.now())) {
      unlinkSync(join(dir, name))
      memoryLog(`removed old snapshot ${name}`)
    }
  } catch {
    /* no diagnostics folder: nothing to remove */
  }
}

let started = false

export function startMemoryWatch(): void {
  if (started) return
  started = true
  const state: WatchState = { loggedAt: 0, loggedHeap: 0, snapshotTaken: false }
  memoryLog(`start version=${app.getVersion()}`)
  pruneSnapshots()
  const timer = setInterval(() => {
    const u = process.memoryUsage()
    const sample = { at: Date.now(), heapUsed: u.heapUsed }
    const verdict = memoryVerdict(sample, state)
    if (!verdict.log) return
    state.loggedAt = sample.at
    state.loggedHeap = sample.heapUsed
    memoryLog(
      `heap=${mb(u.heapUsed)} heapTotal=${mb(u.heapTotal)} external=${mb(u.external)} ` +
        `rss=${mb(u.rss)} sessions=${listSessions().length} webContents=${webContents.getAllWebContents().length}`
    )
    if (verdict.snapshot) {
      state.snapshotTaken = true
      memoryLog(`snapshot ${takeSnapshot() ?? 'failed'}`)
    }
  }, SAMPLE_MS)
  timer.unref()
}
