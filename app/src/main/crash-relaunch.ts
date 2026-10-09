import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { dirname } from 'path'

/**
 * Reopen Superagent when it dies without being asked to.
 *
 * Main going down takes every agent with it, and a crash leaves nothing behind
 * to say so: the window is simply gone, and whoever was reaching this Mac from
 * a phone finds it unreachable until someone sits down at it. A process cannot
 * restart itself after a native crash, so a small shell is started beside it
 * that waits for this process to end and opens the app again. Quitting on
 * purpose stops the shell first, so only a crash (or a Force Quit) reopens.
 *
 * Not when the app lived under a minute: a crash at launch would otherwise
 * reopen into the same crash for good.
 */

/** Wait for pid $1 to end, then open the app at $2 if it ran for $3 seconds. */
export const WATCH_SCRIPT =
  'start=$(date +%s); ' +
  'while kill -0 "$1" 2>/dev/null; do sleep 2; done; ' +
  '[ $(( $(date +%s) - start )) -ge "$3" ] && sleep 1 && exec /usr/bin/open "$2"'

const MIN_UPTIME_S = 60

/** The .app that holds this executable, or null when not run from one. */
export function appBundleOf(execPath: string): string | null {
  // …/SuperAgent.app/Contents/MacOS/SuperAgent
  const bundle = dirname(dirname(dirname(execPath)))
  return bundle.endsWith('.app') ? bundle : null
}

let watcher: ChildProcess | null = null

export function stopCrashRelaunch(): void {
  try {
    watcher?.kill()
  } catch {
    // Already gone.
  }
  watcher = null
}

export function startCrashRelaunch(): void {
  // Never from source or a test run: there is no installed app to reopen.
  if (process.platform !== 'darwin' || !app.isPackaged || process.env.COVE_USER_DATA) return
  if (watcher) return
  const bundle = appBundleOf(process.execPath)
  if (!bundle) return
  try {
    watcher = spawn(
      '/bin/sh',
      ['-c', WATCH_SCRIPT, 'sh', String(process.pid), bundle, String(MIN_UPTIME_S)],
      { detached: true, stdio: 'ignore' }
    )
    watcher.unref()
    watcher.on('exit', () => (watcher = null))
  } catch {
    watcher = null
  }
  // Every way out that is not a crash. app.exit skips the first two.
  app.on('will-quit', stopCrashRelaunch)
  app.on('quit', stopCrashRelaunch)
  process.on('exit', stopCrashRelaunch)
}
