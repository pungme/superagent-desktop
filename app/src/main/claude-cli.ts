import { execSync, exec } from 'child_process'

/**
 * Resolves the `claude` binary via a login shell (so the user's real PATH —
 * nvm/homebrew/~/.local/bin — is loaded), cached process-wide so the slow
 * login-shell spawn happens at most once.
 */

let cachedPath: string | null = null

function loginShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

/** Run a command in a login+interactive shell and return trimmed stdout. */
export function loginShellExec(cmd: string, timeoutMs = 8000): string {
  return execSync(`${loginShell()} -lic ${JSON.stringify(cmd)} 2>/dev/null`, {
    encoding: 'utf8',
    timeout: timeoutMs
  }).trim()
}

/**
 * Async twin of loginShellExec. The sync version BLOCKS THE MAIN PROCESS for the
 * whole login-shell + command run (seconds when the command is a Node CLI) —
 * while it runs, every queued IPC stalls and the window can't hide native views,
 * so a modal opened at the wrong moment sits invisible under the browser pane.
 * Anything called from an ipcMain handler must use this instead.
 */
export function loginShellExecAsync(cmd: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      `${loginShell()} -lic ${JSON.stringify(cmd)} 2>/dev/null`,
      { encoding: 'utf8', timeout: timeoutMs },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    )
  })
}

/** Absolute path to `claude`, resolved once via a login shell. Falls back to bare `claude`. */
export function findClaude(): string {
  if (cachedPath) return cachedPath
  try {
    const resolved = loginShellExec('command -v claude').split('\n').pop()
    // Only cache a real resolution. Caching the bare-`claude` fallback would pin
    // it for the whole process even after the PATH later exposes the binary.
    if (resolved && resolved.length > 0) {
      cachedPath = resolved
      return cachedPath
    }
  } catch {
    // fall through to the un-cached fallback
  }
  return 'claude'
}
