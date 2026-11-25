import { execFile } from 'child_process'
import { realpathSync } from 'fs'
import { ipcMain } from 'electron'
import { kvGet } from './store'
import { agentEnv, findAgy, findClaude, findCodex } from './claude-cli'
import {
  CLI_UPDATE_EVERY_MS,
  CLI_UPDATE_FIRST_MS,
  CODEX_UPDATE_COMMAND,
  UPDATED_CLIS,
  codexInstallKind,
  parseCliUpdate,
  versionOf,
  type CliInfo,
  type CliUpdateResult,
  type UpdatedCli
} from '../shared/cli-update'

/**
 * Keeps the agents' CLIs up to date: Claude Code (below), and Antigravity and Codex
 * (updateOtherCli). Claude Code is kept up to date. The CLI's own background updater cannot be
 * counted on (it had sat on a two-week-old version here), and the model list in
 * the picker comes from the CLI, so a new model reaches the user only once the
 * CLI is new enough to list it. `claude update` is the CLI's own command: it
 * installs the newest version beside the old one and switches over, and running
 * chats keep the version they started with.
 *
  * On by default; Settings → Agents turns it off ('cove.cliAutoUpdate' = '0').
 */

export const CLI_UPDATE_KEY = 'cove.cliAutoUpdate'
const RUN_TIMEOUT_MS = 5 * 60 * 1000

export function cliAutoUpdateOn(): boolean {
  return kvGet(CLI_UPDATE_KEY) !== '0'
}

export interface CliStatus {
  /** What `claude --version` says now, or null when there is no CLI. */
  version: string | null
  /** When the last look finished (ms), or 0 before the first. */
  checkedAt: number
  /** Installed by the last look: "2.1.314 → 2.1.325". */
  updatedFrom: string | null
  /** A look is running now. */
  running: boolean
  error: string | null
}

let status: CliStatus = {
  version: null,
  checkedAt: 0,
  updatedFrom: null,
  running: false,
  error: null
}
let timer: ReturnType<typeof setTimeout> | null = null

type Run = (bin: string, args: string[]) => Promise<{ out: string; ok: boolean }>

const run: Run = (bin, args) =>
  new Promise((resolve) =>
    execFile(
      bin,
      args,
      { timeout: RUN_TIMEOUT_MS, env: agentEnv(bin), maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({ out: `${stdout ?? ''}\n${stderr ?? ''}`, ok: !err })
    )
  )

/** The version `claude --version` reports ("2.1.325 (Claude Code)" → "2.1.325"). */
async function installedVersion(bin: string, exec: Run): Promise<string | null> {
  const r = await exec(bin, ['--version'])
  return /(\d+\.\d+\.\d+)/.exec(r.out)?.[1] ?? null
}

/** Look now and install what is newer. Exported for the test, which passes a stand-in. */
export async function updateClaudeCli(
  exec: Run = run,
  bin: string = findClaude()
): Promise<CliStatus> {
  if (status.running) return status
  status = { ...status, running: true, error: null }
  let result: CliUpdateResult | null = null
  try {
    const r = await exec(bin, ['update'])
    result = parseCliUpdate(r.out)
    if (!r.ok && !result.updated) status.error = 'Claude Code could not check for updates.'
    status = {
      ...status,
      version: result.version ?? (await installedVersion(bin, exec)),
      updatedFrom: result.updated ? result.from : status.updatedFrom
    }
  } catch (e) {
    status.error = (e as Error).message
  }
  status = { ...status, running: false, checkedAt: Date.now() }
  return status
}

export function cliStatus(): CliStatus {
  return status
}

// --- Antigravity and Codex ----------------------------------------------------
//
// Neither is told by its version output whether an update happened, so each is
// judged by `--version` before and after. Antigravity has `agy update`. Codex has
// no updater of its own and is updated the way it was installed: npm or Homebrew,
// found from where the binary really is. A Codex installed some other way is left
// alone — a second copy beside it would only add confusion.

const blank = (): CliInfo => ({
  version: null,
  checkedAt: 0,
  updatedFrom: null,
  running: false,
  error: null,
  skipped: null
})
const others: Record<'codex' | 'antigravity', CliInfo> = {
  codex: blank(),
  antigravity: blank()
}

/** The command to run through a login shell (so npm and brew resolve as in Terminal). */
type Shell = (command: string) => Promise<{ out: string; ok: boolean }>

const shellRun: Shell = (command) =>
  new Promise((resolve) =>
    execFile(
      process.env.SHELL || '/bin/zsh',
      ['-lic', command],
      { timeout: RUN_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => resolve({ out: `${stdout ?? ''}\n${stderr ?? ''}`, ok: !err })
    )
  )

export interface OtherCliDeps {
  exec: Run
  shell: Shell
  /** Where `codex` on the PATH really is, links followed; null when there is none. */
  realPath: (bin: string) => string | null
}

const realDeps: OtherCliDeps = {
  exec: run,
  shell: shellRun,
  realPath: (bin) => {
    try {
      return realpathSync(bin)
    } catch {
      return null
    }
  }
}

export async function updateOtherCli(
  which: 'codex' | 'antigravity',
  deps: OtherCliDeps = realDeps,
  bin: string = which === 'codex' ? findCodex() : findAgy()
): Promise<CliInfo> {
  const cur = others[which]
  if (cur.running) return cur
  others[which] = { ...cur, running: true, error: null, skipped: null }
  try {
    const before = versionOf((await deps.exec(bin, ['--version'])).out)
    if (!before) {
      // Not installed (or not signed in to a working copy): nothing to keep up.
      others[which] = { ...others[which], version: null }
    } else {
      let command: string | null = null
      if (which === 'antigravity') command = `${quote(bin)} update`
      else {
        const real = deps.realPath(bin)
        const kind = real ? codexInstallKind(real) : 'other'
        if (kind === 'other')
          others[which] = {
            ...others[which],
            skipped: 'Codex was installed in a way Superagent does not update.'
          }
        else command = CODEX_UPDATE_COMMAND[kind]
      }
      let after = before
      if (command) {
        const r = await deps.shell(command)
        after = versionOf((await deps.exec(bin, ['--version'])).out) ?? before
        if (!r.ok && after === before)
          others[which] = {
            ...others[which],
            error: `${which === 'codex' ? 'Codex' : 'Antigravity'} could not check for updates.`
          }
      }
      others[which] = {
        ...others[which],
        version: after,
        updatedFrom: after !== before ? before : others[which].updatedFrom
      }
    }
  } catch (e) {
    others[which] = { ...others[which], error: (e as Error).message }
  }
  others[which] = { ...others[which], running: false, checkedAt: Date.now() }
  return others[which]
}

/** A path as one shell word. */
function quote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/** Every agent's CLI as the last look found it. */
export function cliStatusAll(): Record<UpdatedCli, CliInfo> {
  return {
    claude: { ...blank(), ...status, skipped: null },
    codex: others.codex,
    antigravity: others.antigravity
  }
}

/** Look at all three, one after the other (never two installs at once). */
export async function updateAllClis(): Promise<Record<UpdatedCli, CliInfo>> {
  for (const which of UPDATED_CLIS) {
    if (which === 'claude') await updateClaudeCli()
    else await updateOtherCli(which)
  }
  return cliStatusAll()
}

/** Soon after launch, then twice a day, for as long as the app is open and the setting is on. */
export function startCliAutoUpdate(): void {
  if (timer) return
  // A test run, or an app that is not a macOS/Linux build with a CLI to find, leaves it alone.
  if (process.env.COVE_USER_DATA || process.env.COVE_E2E_CLAUDE_BIN || process.env.COVE_E2E_AGY_BIN)
    return
  const tick = (): void => {
    if (cliAutoUpdateOn()) void updateAllClis()
    timer = setTimeout(tick, CLI_UPDATE_EVERY_MS)
    timer.unref()
  }
  timer = setTimeout(tick, CLI_UPDATE_FIRST_MS)
  timer.unref()
}

export function registerCliUpdaterIpc(): void {
  ipcMain.handle('cli:status', () => cliStatus())
  ipcMain.handle('cli:update-now', () => updateAllClis().then((all) => all.claude))
  ipcMain.handle('cli:status-all', () => cliStatusAll())
  ipcMain.handle('cli:update-all-now', () => updateAllClis())
}

/** Tests only: forget what the last look found. */
export function _resetCliUpdaterForTests(): void {
  others.codex = blank()
  others.antigravity = blank()
}
