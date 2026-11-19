import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, readFileSync, readdirSync, statSync, watch } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { bootDevice } from './simulator'
import { kvDel, kvGet, kvSet } from './store'
import { healthLog } from './health'
import {
  LOOP_QUIET_MS,
  LOOP_WINDOW_MS,
  loopingDevices,
  parseSpringBoardCrash,
  type SpringBoardCrash
} from '../shared/crash-loop'

/**
 * A simulator whose SpringBoard keeps crashing (macOS 27 beta: 15 times in two
 * minutes, each with a "SpringBoard quit unexpectedly" pop-up) is restarted once.
 * Each crash leaves a report that names its device; four in 90 seconds, still going,
 * and that device is shut down and booted again, no more than once in ten minutes.
 * Logged to memory.log either way. Also: the switch that hides those pop-ups.
 */

const run = promisify(execFile)
const REPORTS = join(homedir(), 'Library', 'Logs', 'DiagnosticReports')
let crashes: SpringBoardCrash[] = []
const restartedAt = new Map<string, number>()
const seen = new Set<string>()

/**
 * While a SpringBoard loop runs, its pop-ups are switched off, and switched back on
 * when it has been quiet a few minutes: 15 dialogs in two minutes are the worst of
 * it. Only when the person had them on; what they chose by hand is never undone.
 */
const TEMP_KEY = 'sim.popupsOffForLoop'
let quietTimer: NodeJS.Timeout | null = null
async function popupsBackOn(): Promise<void> {
  if (quietTimer) clearTimeout(quietTimer)
  quietTimer = null
  if (kvGet(TEMP_KEY) !== '1') return
  kvDel(TEMP_KEY)
  await run('defaults', ['delete', 'com.apple.CrashReporter', 'DialogType']).catch(() => {})
  healthLog('simulator crash loop over: pop-ups back on')
}
async function popupsOffForLoop(): Promise<void> {
  if (!(await dialogsHidden()) && kvGet(TEMP_KEY) !== '1') {
    kvSet(TEMP_KEY, '1')
    await run('defaults', [
      'write',
      'com.apple.CrashReporter',
      'DialogType',
      '-string',
      'none'
    ]).catch(() => kvDel(TEMP_KEY))
    healthLog('simulator crash loop: pop-ups off until it has been quiet')
  }
  if (quietTimer) clearTimeout(quietTimer)
  quietTimer = setTimeout(() => void popupsBackOn(), LOOP_QUIET_MS)
  quietTimer.unref()
}

async function restart(udid: string): Promise<void> {
  restartedAt.set(udid, Date.now())
  healthLog(`simulator ${udid.slice(0, 8)}: SpringBoard crashing in a loop, restarting it`)
  await run('xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 }).catch(() => {})
  await bootDevice(udid).catch((e) =>
    healthLog(`simulator ${udid.slice(0, 8)}: restart failed: ${String(e).slice(0, 120)}`)
  )
}

function take(file: string): void {
  if (!/^SpringBoard-.*\.ips$/.test(file) || seen.has(file)) return
  seen.add(file)
  let text: string
  try {
    text = readFileSync(join(REPORTS, file), 'utf8')
  } catch {
    return
  }
  const c = parseSpringBoardCrash(text)
  if (!c) return
  const now = Date.now()
  crashes = [...crashes.filter((x) => now - x.at < LOOP_WINDOW_MS), c]
  // Any SpringBoard crash after the first two starts a loop's quiet: no new pop-ups.
  if (crashes.filter((x) => x.udid === c.udid).length >= 2) void popupsOffForLoop()
  for (const udid of loopingDevices(crashes, now, restartedAt)) void restart(udid)
}

let watcher: ReturnType<typeof watch> | null = null
export function startSimWatch(): void {
  if (watcher || process.env.COVE_USER_DATA || !existsSync(REPORTS)) return
  // The app quit in the middle of a loop: the pop-ups it switched off come back now.
  void popupsBackOn()
  // Reports already there are history: only new ones count.
  for (const f of readdirSync(REPORTS)) if (statSync(join(REPORTS, f)).isFile()) seen.add(f)
  try {
    watcher = watch(REPORTS, (_ev, file) => {
      if (file) take(String(file))
    })
    watcher.on('error', () => {
      watcher = null
    })
  } catch {
    watcher = null
  }
}

/** "Quit unexpectedly" pop-ups hidden: macOS's own switch, for the whole user, not just simulators. */
async function dialogsHidden(): Promise<boolean> {
  try {
    const { stdout } = await run('defaults', ['read', 'com.apple.CrashReporter', 'DialogType'])
    return stdout.trim() === 'none'
  } catch {
    return false
  }
}

export function registerSimWatchIpc(): void {
  ipcMain.handle('sim:crash-dialogs', () => dialogsHidden())
  ipcMain.handle('sim:crash-dialogs-set', async (_e, hide: unknown) => {
    // A choice made by hand replaces the loop's temporary one.
    kvDel(TEMP_KEY)
    try {
      if (hide)
        await run('defaults', ['write', 'com.apple.CrashReporter', 'DialogType', '-string', 'none'])
      else await run('defaults', ['delete', 'com.apple.CrashReporter', 'DialogType'])
    } catch {
      // deleting a key that is not there fails; the state below is what matters
    }
    return dialogsHidden()
  })
}
