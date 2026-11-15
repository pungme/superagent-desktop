import { execFile } from 'child_process'
import { ipcMain } from 'electron'
import { kvGet } from './store'
import { agentEnv, findClaude } from './claude-cli'
import {
  CLI_UPDATE_EVERY_MS,
  CLI_UPDATE_FIRST_MS,
  parseCliUpdate,
  type CliUpdateResult
} from '../shared/cli-update'

/**
 * Keeps Claude Code up to date. The CLI's own background updater cannot be
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

/** Soon after launch, then twice a day, for as long as the app is open and the setting is on. */
export function startCliAutoUpdate(): void {
  if (timer) return
  // A test run, or an app that is not a macOS/Linux build with a CLI to find, leaves it alone.
  if (process.env.COVE_USER_DATA || process.env.COVE_E2E_CLAUDE_BIN) return
  const tick = (): void => {
    if (cliAutoUpdateOn()) void updateClaudeCli()
    timer = setTimeout(tick, CLI_UPDATE_EVERY_MS)
    timer.unref()
  }
  timer = setTimeout(tick, CLI_UPDATE_FIRST_MS)
  timer.unref()
}

export function registerCliUpdaterIpc(): void {
  ipcMain.handle('cli:status', () => cliStatus())
  ipcMain.handle('cli:update-now', () => updateClaudeCli())
}
