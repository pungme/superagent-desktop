import { BrowserWindow } from 'electron'
import { execFile } from 'child_process'
import { existsSync, readFileSync, rmSync, statSync, statfsSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Compacting the conversation stores. Deleted chats and cleared transcripts leave free pages behind
 * that SQLite keeps rather than gives back (on one real Mac: 260 MB free inside an 830 MB cove.db).
 * VACUUM rewrites a store without them, but it needs the store to itself, so it cannot run while the
 * app writes events: the person asks for it, the app restarts, and it runs first thing on the way
 * up, before anything opens the stores, with a small window saying so. It runs in the system's own
 * sqlite3 in a separate process, so even a long one never freezes the app.
 */
export const STORES = ['cove.db', 'transcripts.sqlite'] as const
const FLAG = 'compact-on-start'
const RESULT = 'compact-result.json'

export interface StoreSpace {
  file: string
  bytes: number
  /** Space inside the file that compacting gives back. */
  freeBytes: number
}

function sqlite(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/sqlite3', args, { encoding: 'utf8', timeout: timeoutMs }, (err, out) =>
      err ? reject(err) : resolve(out)
    )
  })
}

/** How big each store is and how much of it is free pages (read-only, quick). */
export async function storeSpace(userData: string): Promise<StoreSpace[]> {
  const out: StoreSpace[] = []
  for (const file of STORES) {
    const path = join(userData, file)
    if (!existsSync(path)) continue
    let bytes = 0
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        bytes += statSync(path + suffix).size
      } catch {
        // not there
      }
    }
    let freeBytes = 0
    try {
      const r = await sqlite(
        ['-readonly', `file:${path}?mode=ro`, 'PRAGMA freelist_count; PRAGMA page_size;'],
        10_000
      )
      const [free, page] = r.trim().split('\n').map(Number)
      freeBytes = (free || 0) * (page || 0)
    } catch {
      // unreadable right now: nothing to promise
    }
    out.push({ file, bytes, freeBytes })
  }
  return out
}

/** Ask for a compaction on the next start. */
export function requestCompact(userData: string): void {
  writeFileSync(join(userData, FLAG), String(Date.now()))
}

/** What the last compaction did, for Settings to say; read once and forgotten. */
export function takeCompactResult(
  userData: string
): { at: number; before: number; after: number; failed?: string } | null {
  const path = join(userData, RESULT)
  if (!existsSync(path)) return null
  try {
    const r = JSON.parse(readFileSync(path, 'utf8'))
    rmSync(path, { force: true })
    return r
  } catch {
    rmSync(path, { force: true })
    return null
  }
}

function waitWindow(): BrowserWindow | null {
  try {
    const w = new BrowserWindow({
      width: 380,
      height: 150,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Superagent',
      show: true,
      webPreferences: { sandbox: true }
    })
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;font:13px -apple-system,system-ui;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;gap:8px;color:#1d1d1f;background:#f5f5f7"><b style="font-size:15px">Compacting your conversations…</b><span style="color:#6e6e73">This takes about a minute. Superagent opens when it is done.</span></body>`
    void w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    return w
  } catch {
    return null
  }
}

/**
 * Run a compaction that was asked for, before the stores are opened. Never blocks the main
 * thread (the work is a child process), never throws, and gives up on a store it cannot do.
 */
export async function runPendingCompact(userData: string): Promise<void> {
  const flag = join(userData, FLAG)
  if (!existsSync(flag)) return
  // Gone before anything else, so a compaction that crashes is never tried again in a loop.
  rmSync(flag, { force: true })
  const sizeOf = (): number =>
    STORES.reduce((n, f) => {
      for (const s of ['', '-wal', '-shm'])
        try {
          n += statSync(join(userData, f + s)).size
        } catch {
          // not there
        }
      return n
    }, 0)
  const before = sizeOf()
  let failed: string | undefined
  const win = waitWindow()
  try {
    for (const file of STORES) {
      const path = join(userData, file)
      if (!existsSync(path)) continue
      // VACUUM writes a full copy before it lets go of the old one: it needs that much room.
      try {
        const fs = statfsSync(userData)
        if (fs.bavail * fs.bsize < statSync(path).size * 1.2) {
          failed = `Not enough free disk space to compact ${file}.`
          continue
        }
      } catch {
        // could not tell: try anyway, VACUUM fails safely
      }
      try {
        await sqlite(
          [path, 'PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);'],
          15 * 60_000
        )
      } catch (e) {
        // VACUUM is a transaction: a failure leaves the store as it was.
        failed = `${file}: ${String((e as Error).message ?? e).slice(0, 200)}`
      }
    }
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
  }
  try {
    writeFileSync(
      join(userData, RESULT),
      JSON.stringify({ at: Date.now(), before, after: sizeOf(), ...(failed ? { failed } : {}) })
    )
  } catch {
    // Settings just won't say
  }
}
