import { ipcMain } from 'electron'
import { execSync } from 'child_process'

/**
 * Detects whether the user's machine is ready: is the `claude` binary installed,
 * and is it logged in? Drives the onboarding flow.
 */

export interface EnvStatus {
  claudeInstalled: boolean
  claudeVersion: string | null
  loggedIn: boolean
}

function shell(): string {
  return process.env.SHELL || '/bin/zsh'
}

function loginShellExec(cmd: string, timeoutMs = 8000): string {
  return execSync(`${shell()} -lic ${JSON.stringify(cmd)} 2>/dev/null`, {
    encoding: 'utf8',
    timeout: timeoutMs
  }).trim()
}

export function detectEnvironment(): EnvStatus {
  let claudeInstalled = false
  let claudeVersion: string | null = null
  let loggedIn = false

  try {
    const version = loginShellExec('claude --version')
    if (version) {
      claudeInstalled = true
      // e.g. "2.1.220 (Claude Code)" → "2.1.220"
      claudeVersion = version.split(/\s+/)[0] || version
    }
  } catch {
    claudeInstalled = false
  }

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
}
