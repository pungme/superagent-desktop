import { ipcMain, WebContents } from 'electron'
import { spawn } from 'child_process'
import { loginShellExec, loginShellExecAsync } from './claude-cli'
import { AGENT_PROVIDERS, type AgentProvider } from '../shared/agent-provider'

/**
 * Is the user's machine ready to run an agent — is the CLI installed, and is it
 * signed in? Drives onboarding, and the version line in Settings.
 *
 * Superagent supports more than one agent, and needs only one of them to work.
 * So this reports on each independently and onboarding decides: a machine that
 * already has either Claude Code or Codex installed and signed in needs no
 * setup at all, and never sees the flow.
 */

export interface ProviderStatus {
  installed: boolean
  version: string | null
  loggedIn: boolean
}

export interface EnvStatus {
  claude: ProviderStatus
  codex: ProviderStatus
  /**
   * The pre-Codex shape, kept so every existing caller (Settings' version line,
   * the e2e specs) keeps working unchanged. `loggedIn` now means "at least one
   * agent is ready", which is what it was always used to decide.
   */
  claudeInstalled: boolean
  claudeVersion: string | null
  loggedIn: boolean
}

/** True when at least one agent is installed and signed in. */
export function isReady(env: EnvStatus): boolean {
  return AGENT_PROVIDERS.some((p) => env[p].installed && env[p].loggedIn)
}

/** How each provider reports its version, and how it says whether it is signed in. */
const PROBES: Record<
  AgentProvider,
  {
    version: string
    loginCheck: (out: string) => boolean
    loginCommand: string
    /** The command answers on stderr, so it has to be folded into stdout. */
    loginOnStderr?: boolean
  }
> = {
  claude: {
    version: 'claude --version',
    // A logged-out claude prints an auth prompt / exits non-zero for a trivial
    // print. A clean short response is the only reliable "yes".
    loginCommand: 'claude -p "reply with the single word: ok" --max-turns 1',
    loginCheck: (out) => /\bok\b/i.test(out)
  },
  codex: {
    version: 'codex --version',
    // Codex answers this directly, in milliseconds — no inference call needed.
    // It writes the answer to stderr, though, which the shell helper discards by
    // default: without loginOnStderr this silently reads "not signed in" always.
    loginCommand: 'codex login status',
    loginOnStderr: true,
    loginCheck: (out) => /logged in/i.test(out) && !/not logged in/i.test(out)
  }
}

// A CLI's version can't change mid-run, so one probe serves the whole session.
// Uncached, every Settings open paid for an interactive zsh + the CLI's startup.
let versionCache: Record<AgentProvider, { installed: boolean; version: string | null }> | null =
  null

function parseVersion(raw: string): string {
  // e.g. "2.1.220 (Claude Code)" → "2.1.220"; regex rather than first-word, since
  // an interactive shell may print rc noise before the real output.
  const m = raw.match(/\d+\.\d+\.\d+\S*/)
  return m ? m[0] : raw.trim()
}

/** Async + cached: never blocks main. A total miss is not cached, so a re-check still works. */
export async function detectVersionAsync(): Promise<
  Record<AgentProvider, { installed: boolean; version: string | null }>
> {
  if (versionCache) return versionCache
  const found = {} as Record<AgentProvider, { installed: boolean; version: string | null }>
  await Promise.all(
    AGENT_PROVIDERS.map(async (provider) => {
      try {
        const raw = await loginShellExecAsync(PROBES[provider].version)
        found[provider] = raw
          ? { installed: true, version: parseVersion(raw) }
          : { installed: false, version: null }
      } catch {
        found[provider] = { installed: false, version: null }
      }
    })
  )
  if (AGENT_PROVIDERS.some((p) => found[p].installed)) versionCache = found
  return found
}

/** Sync twin, for the few callers that run off the IPC path. */
export function detectVersion(): Record<
  AgentProvider,
  { installed: boolean; version: string | null }
> {
  if (versionCache) return versionCache
  const found = {} as Record<AgentProvider, { installed: boolean; version: string | null }>
  for (const provider of AGENT_PROVIDERS) {
    try {
      const raw = loginShellExec(PROBES[provider].version)
      found[provider] = raw
        ? { installed: true, version: parseVersion(raw) }
        : { installed: false, version: null }
    } catch {
      found[provider] = { installed: false, version: null }
    }
  }
  if (AGENT_PROVIDERS.some((p) => found[p].installed)) versionCache = found
  return found
}

/**
 * The full picture, sign-in included.
 *
 * The two probes run concurrently: Codex answers instantly, Claude's costs a
 * real (tiny) inference call, and there is no reason to pay for them in series
 * while someone waits on a first-run screen.
 */
export async function detectEnvironment(): Promise<EnvStatus> {
  const versions = await detectVersionAsync()
  const statuses = {} as Record<AgentProvider, ProviderStatus>
  await Promise.all(
    AGENT_PROVIDERS.map(async (provider) => {
      const { installed, version } = versions[provider]
      let loggedIn = false
      if (installed) {
        try {
          const out = await loginShellExecAsync(
            PROBES[provider].loginCommand,
            30000,
            PROBES[provider].loginOnStderr
          )
          loggedIn = PROBES[provider].loginCheck(out)
        } catch {
          loggedIn = false
        }
      }
      statuses[provider] = { installed, version, loggedIn }
    })
  )
  const env: EnvStatus = {
    ...statuses,
    claudeInstalled: statuses.claude.installed,
    claudeVersion: statuses.claude.version,
    loggedIn: false
  }
  env.loggedIn = isReady(env)
  return env
}

/**
 * Install an agent for the user, streaming progress lines back so onboarding can
 * show what is happening. Runs in a login shell so PATH/curl/npm resolve normally.
 *
 * Claude Code goes in via Anthropic's native installer — a standalone binary into
 * ~/.local/bin, so it needs no Node or npm, which is the whole point for a
 * non-developer's first run. Codex has no such installer, so it goes in via npm.
 */
const INSTALL_COMMAND: Record<AgentProvider, string> = {
  claude: 'curl -fsSL https://claude.ai/install.sh | bash',
  codex: 'npm install -g @openai/codex'
}

export function installProvider(
  provider: AgentProvider,
  onLine: (line: string) => void
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || '/bin/zsh'
    const proc = spawn(shell, ['-lc', INSTALL_COMMAND[provider]], { env: process.env })
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
 * Open Terminal and run the CLI's one-time interactive sign-in. The auth flow is
 * a TUI/browser handshake we can't do silently, but this makes it a single click
 * instead of "open your terminal and type this".
 */
const LOGIN_COMMAND: Record<AgentProvider, string> = {
  claude: 'claude',
  codex: 'codex login'
}

export function openProviderLogin(provider: AgentProvider): void {
  spawn('osascript', [
    '-e',
    'tell application "Terminal" to activate',
    '-e',
    `tell application "Terminal" to do script "${LOGIN_COMMAND[provider]}"`
  ])
}

export function registerEnvironmentIpc(): void {
  ipcMain.handle('env:detect', () => detectEnvironment())
  // Async + cached — the sync variant blocked main for the shell + CLI startup,
  // which is exactly the beat where Settings is opening.
  ipcMain.handle('env:version', () => detectVersionAsync())
  // Warm the cache off the startup path so even the first Settings open is instant.
  void detectVersionAsync()

  // Install an agent, streaming progress to the caller's window.
  ipcMain.handle('env:install', (e, provider: AgentProvider) =>
    installProvider(provider, (line) => {
      const wc = e.sender as WebContents
      if (!wc.isDestroyed()) wc.send('env:install-progress', line)
    })
  )
  ipcMain.on('env:open-login', (_e, provider: AgentProvider) => openProviderLogin(provider))
}
