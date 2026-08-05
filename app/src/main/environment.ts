import { ipcMain } from 'electron'
import { loginShellExec, loginShellExecAsync } from './claude-cli'

/**
 * Detects whether the user's machine is ready: is the `claude` binary installed,
 * and is it logged in? Drives the onboarding flow.
 */

export interface EnvStatus {
  claudeInstalled: boolean
  claudeVersion: string | null
  loggedIn: boolean
}

// The CLI's version can't change mid-run, so one probe serves the whole session.
// Uncached, every Settings open paid for an interactive zsh + the claude CLI's
// startup — synchronously, on main.
let versionCache: { claudeInstalled: boolean; claudeVersion: string | null } | null = null

/** Async + cached: never blocks main. A miss (not installed) is not cached, so onboarding's Re-check still works. */
export async function detectVersionAsync(): Promise<{
  claudeInstalled: boolean
  claudeVersion: string | null
}> {
  if (versionCache) return versionCache
  try {
    const version = await loginShellExecAsync('claude --version')
    if (version) {
      const m = version.match(/\d+\.\d+\.\d+\S*/)
      versionCache = { claudeInstalled: true, claudeVersion: m ? m[0] : version }
      return versionCache
    }
  } catch {
    // not installed
  }
  return { claudeInstalled: false, claudeVersion: null }
}

/** Cheap check: is claude installed, and what version? No inference call. */
export function detectVersion(): { claudeInstalled: boolean; claudeVersion: string | null } {
  if (versionCache) return versionCache
  try {
    const version = loginShellExec('claude --version')
    if (version) {
      // e.g. "2.1.220 (Claude Code)" → "2.1.220"; regex rather than first-word,
      // since an interactive shell may print rc noise before the real output.
      const m = version.match(/\d+\.\d+\.\d+\S*/)
      versionCache = { claudeInstalled: true, claudeVersion: m ? m[0] : version }
      return versionCache
    }
  } catch {
    // not installed
  }
  return { claudeInstalled: false, claudeVersion: null }
}

export function detectEnvironment(): EnvStatus {
  const { claudeInstalled, claudeVersion } = detectVersion()
  let loggedIn = false

  if (claudeInstalled) {
    // A logged-out claude prints an auth prompt / non-zero exit for a trivial print.
    // We treat a clean short response as "logged in".
    try {
      const out = loginShellExec('claude -p "reply with the single word: ok" --max-turns 1', 30000)
      loggedIn = /\bok\b/i.test(out)
    } catch {
      loggedIn = false
    }
  }

  return { claudeInstalled, claudeVersion, loggedIn }
}

export function registerEnvironmentIpc(): void {
  ipcMain.handle('env:detect', () => detectEnvironment())
  // Async + cached — the sync variant blocked main for the shell + CLI startup,
  // which is exactly the beat where Settings is opening.
  ipcMain.handle('env:version', () => detectVersionAsync())
  // Warm the cache off the startup path so even the first Settings open is instant.
  void detectVersionAsync()
}
