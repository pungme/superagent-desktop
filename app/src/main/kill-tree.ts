import { ChildProcess, execFile } from 'child_process'

/**
 * A plain `proc.kill()` only signals the process Node itself spawned — a
 * Bash tool call, an `xcodebuild`, a dev server the agent launched underneath
 * it are separate processes and are left running, orphaned. Pressing Stop
 * then looked like it did nothing: the CLI process was gone, but the actual
 * work (and its CPU, its port, its file locks) kept going.
 *
 * Requires the process to have been spawned with `detached: true` on POSIX
 * (see DETACH_FOR_TREE_KILL) — that makes it the leader of its own process
 * group, so `-pid` reaches everything it spawned rather than Electron's own
 * group. Windows has no such concept; `taskkill /T` walks the process tree
 * itself instead, and doesn't need the process detached to do it.
 */
export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (proc.pid == null) return
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(proc.pid), '/T', '/F'], () => {})
    return
  }
  try {
    process.kill(-proc.pid, signal)
  } catch {
    try {
      proc.kill(signal)
    } catch {
      // already gone
    }
  }
}

/**
 * Stop a process and everything under it, and make sure of it.
 *
 * SIGTERM is a request. An agent in the middle of a turn can take it and carry
 * on: on 2026-10-10 a chat's `claude` that had been stopped to make way for a
 * new one kept working for minutes, unseen by the app, in the same folder as
 * its replacement, and pushed a release. So what is still running after
 * `graceMs` is killed outright.
 */
export function killProcessTreeForSure(proc: ChildProcess, graceMs = 4000): void {
  killProcessTree(proc)
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const timer = setTimeout(() => killProcessTree(proc, 'SIGKILL'), graceMs)
  timer.unref?.()
  proc.once('exit', () => clearTimeout(timer))
}

/** Whether to spawn detached for killProcessTree's group-signal to work.
 *  POSIX only — `detached: true` means something unrelated on Windows (its
 *  own console), and taskkill /T doesn't need it. */
export const DETACH_FOR_TREE_KILL = process.platform !== 'win32'

/**
 * One-shot runs the app starts outside a chat session — routine runs, `codex
 * exec` — so quitting can take them down too. Chat agents have their own
 * registry (killAllAgents); without this one a routine mid-run kept going after
 * the app quit, still driving tools until it ran out of turns.
 */
const oneShots = new Set<ChildProcess>()

/** Register a one-shot run (spawned with DETACH_FOR_TREE_KILL) until it exits. */
export function trackOneShot(proc: ChildProcess): void {
  oneShots.add(proc)
  proc.once('exit', () => oneShots.delete(proc))
  proc.once('error', () => oneShots.delete(proc))
}

/** On quit: stop every one-shot still running, and everything it started. */
export function killAllOneShots(): void {
  for (const proc of oneShots) killProcessTree(proc)
  oneShots.clear()
}
