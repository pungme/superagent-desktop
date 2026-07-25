import { ipcMain } from 'electron'
import { loginShellExec } from './claude-cli'

/**
 * Detects whether the user's machine is ready: is the `claude` binary installed,
 * and is it logged in? Drives the onboarding flow.
 */

export interface EnvStatus {
  claudeInstalled: boolean
  claudeVersion: string | null
  loggedIn: boolean
}

/** Cheap check: is claude installed, and what version? No inference call. */
export function detectVersion(): { claudeInstalled: boolean; claudeVersion: string | null } {
  try {
    const version = loginShellExec('claude --version')
    if (version) {
      // e.g. "2.1.220 (Claude Code)" → "2.1.220"
      return { claudeInstalled: true, claudeVersion: version.split(/\s+/)[0] || version }
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
  // Version-only: cheap, no inference call. Used by Settings.
  ipcMain.handle('env:version', () => detectVersion())
}
