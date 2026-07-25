import { execSync } from 'child_process'

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

/** Absolute path to `claude`, resolved once via a login shell. Falls back to bare `claude`. */
export function findClaude(): string {
  if (cachedPath) return cachedPath
  try {
    const resolved = loginShellExec('command -v claude').split('\n').pop()
    cachedPath = resolved && resolved.length > 0 ? resolved : 'claude'
  } catch {
    cachedPath = 'claude'
  }
  return cachedPath
}
