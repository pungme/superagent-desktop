import { execSync, exec } from 'child_process'
import type { AgentProvider } from '../shared/agent-provider'

/**
 * Resolves an agent's binary (`claude`, `codex`) via a login shell — so the
 * user's real PATH (nvm/homebrew/~/.local/bin) is loaded — cached process-wide
 * so the slow login-shell spawn happens at most once per binary.
 */

const cachedPaths = new Map<string, string>()

function loginShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

/**
 * Run a command in a login+interactive shell and return trimmed output.
 *
 * stderr is discarded by default, because an interactive shell prints rc noise
 * that would otherwise land in a parsed version string. `keepStderr` folds it
 * back in for the commands that answer there — `codex login status` writes its
 * whole answer to stderr, so discarding it reads as "not signed in" forever.
 */
export function loginShellExec(cmd: string, timeoutMs = 8000, keepStderr = false): string {
  return execSync(
    `${loginShell()} -lic ${JSON.stringify(cmd)} ${keepStderr ? '2>&1' : '2>/dev/null'}`,
    {
      encoding: 'utf8',
      timeout: timeoutMs
    }
  ).trim()
}

/**
 * Async twin of loginShellExec. The sync version BLOCKS THE MAIN PROCESS for the
 * whole login-shell + command run (seconds when the command is a Node CLI) —
 * while it runs, every queued IPC stalls and the window can't hide native views,
 * so a modal opened at the wrong moment sits invisible under the browser pane.
 * Anything called from an ipcMain handler must use this instead.
 */
export function loginShellExecAsync(
  cmd: string,
  timeoutMs = 8000,
  keepStderr = false
): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(
      `${loginShell()} -lic ${JSON.stringify(cmd)} ${keepStderr ? '2>&1' : '2>/dev/null'}`,
      { encoding: 'utf8', timeout: timeoutMs },
      (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))
    )
  })
}

/**
 * Absolute path to a CLI, resolved once via a login shell. Falls back to the
 * bare name so a spawn failure still names the binary the user is missing.
 */
export function findBinary(name: string): string {
  const cached = cachedPaths.get(name)
  if (cached) return cached
  try {
    const resolved = loginShellExec(`command -v ${name}`).split('\n').pop()
    // Only cache a real resolution. Caching the bare-name fallback would pin it
    // for the whole process even after the PATH later exposes the binary.
    if (resolved && resolved.length > 0) {
      cachedPaths.set(name, resolved)
      return resolved
    }
  } catch {
    // fall through to the un-cached fallback
  }
  return name
}

/** Absolute path to `claude`. */
export function findClaude(): string {
  return findBinary('claude')
}

/** Absolute path to `codex`. */
export function findCodex(): string {
  return findBinary('codex')
}

/** The binary that drives a given provider. */
export function findAgentBinary(provider: AgentProvider): string {
  return provider === 'codex' ? findCodex() : findClaude()
}
