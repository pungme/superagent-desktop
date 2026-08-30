import { ipcMain, WebContents } from 'electron'
import { spawn } from 'child_process'
import { loginShellExec, loginShellExecAsync } from './claude-cli'

/**
 * Detects whether the user's machine is ready: is the `claude` binary installed,
 * and is it logged in? Drives the onboarding flow.
 */

export interface EnvStatus {
  claudeInstalled: boolean
  claudeVersion: string | null
  loggedIn: boolean
  agyInstalled?: boolean
  agyVersion?: string | null
}

let versionCache: {
  claudeInstalled: boolean
  claudeVersion: string | null
  agyInstalled: boolean
  agyVersion: string | null
} | null = null

/** Async + cached: never blocks main. A miss (not installed) is not cached, so onboarding's Re-check still works. */
export async function detectVersionAsync(): Promise<{
  claudeInstalled: boolean
  claudeVersion: string | null
  agyInstalled: boolean
  agyVersion: string | null
}> {
  if (versionCache) return versionCache
  let claudeInstalled = false
  let claudeVersion: string | null = null
  let agyInstalled = false
  let agyVersion: string | null = null

  try {
    const version = await loginShellExecAsync('claude --version')
    if (version) {
      const m = version.match(/\d+\.\d+\.\d+\S*/)
      claudeInstalled = true
      claudeVersion = m ? m[0] : version
    }
  } catch {
    // not installed
  }

  try {
    const version = await loginShellExecAsync('agy --version || antigravity --version')
    if (version) {
      const m = version.match(/\d+\.\d+\.\d+\S*/)
      agyInstalled = true
      agyVersion = m ? m[0] : version.trim()
    }
  } catch {
    // not installed
  }

  if (claudeInstalled || agyInstalled) {
    versionCache = { claudeInstalled, claudeVersion, agyInstalled, agyVersion }
    return versionCache
  }
  return { claudeInstalled: false, claudeVersion: null, agyInstalled: false, agyVersion: null }
}

/** Cheap check: is claude / agy installed, and what version? No inference call. */
export function detectVersion(): {
  claudeInstalled: boolean
  claudeVersion: string | null
  agyInstalled: boolean
  agyVersion: string | null
} {
  if (versionCache) return versionCache
  let claudeInstalled = false
  let claudeVersion: string | null = null
  let agyInstalled = false
  let agyVersion: string | null = null

  try {
    const version = loginShellExec('claude --version')
    if (version) {
      const m = version.match(/\d+\.\d+\.\d+\S*/)
      claudeInstalled = true
      claudeVersion = m ? m[0] : version
    }
  } catch {
    // not installed
  }

  try {
    const version = loginShellExec('agy --version || antigravity --version')
    if (version) {
      const m = version.match(/\d+\.\d+\.\d+\S*/)
      agyInstalled = true
      agyVersion = m ? m[0] : version.trim()
    }
  } catch {
    // not installed
  }

  if (claudeInstalled || agyInstalled) {
    versionCache = { claudeInstalled, claudeVersion, agyInstalled, agyVersion }
    return versionCache
  }
  return { claudeInstalled: false, claudeVersion: null, agyInstalled: false, agyVersion: null }
}

export function detectEnvironment(): EnvStatus {
  const { claudeInstalled, claudeVersion, agyInstalled, agyVersion } = detectVersion()
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
  } else if (agyInstalled) {
    loggedIn = true
  }

  return { claudeInstalled, claudeVersion, agyInstalled, agyVersion, loggedIn }
}

/**
 * Install Claude Code for the user via Anthropic's native installer — a
 * standalone binary into ~/.local/bin, so it needs no Node/npm (the whole point
 * for a non-dev first run). Streams progress lines back so onboarding can show
 * what's happening. Runs in a login shell so PATH/curl resolve normally.
 */
export function installClaude(
  onLine: (line: string) => void
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const proc = spawn(shell, ['-lc', 'curl -fsSL https://claude.ai/install.sh | bash'], {
      env: process.env
    })
    let err = ''
    proc.stdout.on('data', (d) => onLine(d.toString()))
    proc.stderr.on('data', (d) => {
      const t = d.toString()
      err += t
      onLine(t)
    })
    proc.on('error', (e) => resolve({ ok: false, error: e.message }))
    proc.on('exit', (code) => {
      // Force a fresh probe so the onboarding re-check sees the new binary.
      versionCache = null
      resolve(
        code === 0 ? { ok: true } : { ok: false, error: err.slice(-400).trim() || `exited ${code}` }
      )
    })
  })
}

/**
 * Open Terminal and run `claude` for the one-time interactive sign-in — the auth
 * flow is a TUI/browser handshake we can't do silently, but this makes it a
 * single click instead of "open your terminal and type this".
 */
export function openClaudeLogin(): void {
  spawn('osascript', [
    '-e',
    'tell application "Terminal" to activate',
    '-e',
    'tell application "Terminal" to do script "claude"'
  ])
}

export function registerEnvironmentIpc(): void {
  ipcMain.handle('env:detect', () => detectEnvironment())
  // Async + cached — the sync variant blocked main for the shell + CLI startup,
  // which is exactly the beat where Settings is opening.
  ipcMain.handle('env:version', () => detectVersionAsync())
  // Warm the cache off the startup path so even the first Settings open is instant.
  void detectVersionAsync()

  // Install Claude Code, streaming progress to the caller's window.
  ipcMain.handle('env:install-claude', (e) =>
    installClaude((line) => {
      const wc = e.sender as WebContents
      if (!wc.isDestroyed()) wc.send('env:install-progress', line)
    })
  )
  ipcMain.on('env:open-login', () => openClaudeLogin())
}
