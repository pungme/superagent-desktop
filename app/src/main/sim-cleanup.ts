import { BrowserWindow, dialog, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { getChat, kvGet, kvSet } from './store'
import { chatHoldingSimulator, openSimulators, releaseSimulatorHelpers } from './simulator'
import { healthLog } from './health'
import {
  IDLE_MS,
  autoCleanup,
  describeSimulators,
  simulatorsToSleep,
  type PlanContext,
  type SimInfo,
  type SimRow
} from '../shared/sim-cleanup'

/**
 * Simulators agents create and never delete (2 to 14 GB each; 16 of them were 95 GB).
 * Settings → Simulators lists them for clearing by hand; with "Clear out unused
 * simulators" on (the default), ones that appeared after Superagent's first look, are
 * shut down, held by no conversation and unused for a week go by themselves. What was
 * there at the first look is the person's and is only removed by hand.
 *
 * `sim.` keys are main-owned (shared/kv-owned.ts): only these handlers write them.
 */

const run = promisify(execFile)
const BASELINE_KEY = 'sim.baseline'
const KEEP_KEY = 'sim.keep'
const AUTO_KEY = 'sim.autoClean'
const EVERY_MS = 6 * 60 * 60 * 1000
const FIRST_MS = 3 * 60 * 1000

export function autoCleanOn(): boolean {
  return kvGet(AUTO_KEY) !== '0'
}

/** Every device simctl knows, unavailable ones included, with size and last use. */
export async function scanSimulators(): Promise<SimInfo[]> {
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', '--json'], {
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024
  })
  const parsed = JSON.parse(stdout) as {
    devices: Record<
      string,
      { udid: string; name: string; state: string; dataPathSize?: number; lastUsedAt?: string }[]
    >
  }
  const out: SimInfo[] = []
  for (const list of Object.values(parsed.devices))
    for (const d of list) {
      const at = d.lastUsedAt ? Date.parse(d.lastUsedAt) : NaN
      out.push({
        udid: d.udid,
        name: d.name,
        state: d.state,
        sizeBytes: d.dataPathSize ?? 0,
        lastUsedAt: Number.isNaN(at) ? null : at
      })
    }
  return out
}

/** The UDIDs there at the first look. Fixed then, so later ones count as created since. */
function baseline(devices: SimInfo[]): Set<string> {
  const saved = kvGet(BASELINE_KEY)
  if (saved) {
    try {
      return new Set(JSON.parse(saved) as string[])
    } catch {
      // fall through and take a new one
    }
  }
  // An empty scan is simctl failing, not a Mac with no simulators: do not fix a baseline on it.
  if (devices.length) kvSet(BASELINE_KEY, JSON.stringify(devices.map((d) => d.udid)))
  return new Set(devices.map((d) => d.udid))
}

function heldSet(devices: SimInfo[]): Set<string> {
  const held = new Set<string>()
  const shown = new Set(openSimulators().map((o) => o.udid))
  for (const d of devices) {
    const owner = chatHoldingSimulator(d.udid)
    if (!owner) continue
    // A conversation untouched for days, with no agent running, no longer needs its device.
    const chat = getChat(owner)
    const stale =
      !shown.has(d.udid) &&
      (!chat || (Date.now() - chat.updatedAt > IDLE_MS && !agentRunning(owner)))
    if (!stale) held.add(d.udid)
  }
  for (const u of shown) held.add(u)
  return held
}

/** The UDIDs the person marked Keep. */
function keptSet(): Set<string> {
  try {
    return new Set(JSON.parse(kvGet(KEEP_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function setSimKept(udid: string, on: boolean): string[] {
  const kept = keptSet()
  if (on) kept.add(udid)
  else kept.delete(udid)
  kvSet(KEEP_KEY, JSON.stringify([...kept]))
  return [...kept]
}

let stockNames: Set<string> | null = null
/**
 * The names of Apple's own device types ("iPhone 17", "iPad Pro 11-inch (M5)"), asked
 * once. A simulator named exactly so is a stock one. If simctl cannot say, nothing is
 * taken for stock: the auto clean-up then leaves everything alone, never deleting on a guess.
 */
async function stockSet(): Promise<{ names: Set<string>; known: boolean }> {
  if (stockNames) return { names: stockNames, known: true }
  try {
    const { stdout } = await run('xcrun', ['simctl', 'list', 'devicetypes', '--json'], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024
    })
    const types = (JSON.parse(stdout) as { devicetypes?: { name: string }[] }).devicetypes ?? []
    const names = new Set(types.map((t) => t.name.trim().toLowerCase()).filter(Boolean))
    if (names.size) stockNames = names
    return { names, known: names.size > 0 }
  } catch {
    return { names: new Set(), known: false }
  }
}

async function context(devices: SimInfo[]): Promise<PlanContext & { stockKnown: boolean }> {
  const stock = await stockSet()
  return {
    now: Date.now(),
    held: heldSet(devices),
    kept: keptSet(),
    stock: stock.names,
    stockKnown: stock.known
  }
}

export interface SimCleanupState {
  rows: SimRow[]
  totalBytes: number
  auto: boolean
}

export async function simCleanupState(): Promise<SimCleanupState> {
  const devices = await scanSimulators()
  const rows = describeSimulators(devices, await context(devices))
  return { rows, totalBytes: rows.reduce((n, r) => n + r.sizeBytes, 0), auto: autoCleanOn() }
}

/** Delete these, skipping any that is running or held at this moment. */
export async function deleteSimulators(
  udids: string[]
): Promise<{ deleted: number; freedBytes: number; skipped: number }> {
  const devices = await scanSimulators()
  const ctx = await context(devices)
  const rows = new Map(describeSimulators(devices, ctx).map((r) => [r.udid, r]))
  let deleted = 0
  let freedBytes = 0
  let skipped = 0
  for (const udid of udids) {
    const row = rows.get(udid)
    if (!row || !row.removable) {
      skipped++
      continue
    }
    try {
      await run('xcrun', ['simctl', 'delete', udid], { timeout: 120_000 })
      deleted++
      freedBytes += row.sizeBytes
      healthLog(
        `simulator deleted ${row.name} (${udid.slice(0, 8)}) ${Math.round(row.sizeBytes / 1e6)} MB`
      )
    } catch {
      skipped++
    }
  }
  return { deleted, freedBytes, skipped }
}

/** The automatic pass. Returns what it removed, for the log and tests. */
export async function autoCleanSimulators(): Promise<SimRow[]> {
  const devices = await scanSimulators()
  const ctx = await context(devices)
  if (!autoCleanOn() || !ctx.stockKnown) return []
  const gone = autoCleanup(devices, ctx)
  if (gone.length) {
    const r = await deleteSimulators(gone.map((g) => g.udid))
    healthLog(`simulator clean-up removed ${r.deleted} (${Math.round(r.freedBytes / 1e6)} MB)`)
  }
  return gone
}

// --- booted and left: shut down once unused ---------------------------------

/**
 * Whether a conversation's agent is running. Set by index.ts (agent.ts knows
 * the sessions; importing it here would pull the agents into this module).
 * Until it is set, every agent counts as running: nothing is shut down blind.
 */
let agentRunning: (chatId: string) => boolean = () => true
export function setSimAgentProbe(fn: (chatId: string) => boolean): void {
  agentRunning = fn
}

const idleSince = new Map<string, number>()

/**
 * Shut down the simulators conversations booted and left: no pane shows them,
 * their agent is not running, for ten minutes (shared/sim-cleanup.ts). Each
 * holds a whole iOS; left alone they ran into the thousands of processes.
 * Behind the same switch as the clean-up ("Clear out unused simulators").
 */
export async function sleepIdleSimulators(now = Date.now()): Promise<string[]> {
  if (!autoCleanOn()) return []
  const devices = await scanSimulators()
  const booted = devices.filter((d) => d.state === 'Booted').map((d) => d.udid)
  const gone = simulatorsToSleep({
    booted,
    ownerOf: (udid) => chatHoldingSimulator(udid),
    baseline: baseline(devices),
    shown: new Set(openSimulators().map((o) => o.udid)),
    agentRunning,
    idleSince,
    now
  })
  for (const udid of gone) {
    releaseSimulatorHelpers(udid)
    await run('xcrun', ['simctl', 'shutdown', udid], { timeout: 60_000 }).catch(() => {})
    idleSince.delete(udid)
    const name = devices.find((d) => d.udid === udid)?.name ?? udid.slice(0, 8)
    healthLog(`simulator ${name} (${udid.slice(0, 8)}) shut down: unused for 10 minutes`)
  }
  return gone
}

/**
 * "Turn off every running simulator", for an agent the person asked to. The
 * shell route is refused (sim-guard.ts: it would take other conversations'
 * devices too), so the person says yes here, in a dialog of the app's own that
 * no chat message can answer. Cancel is the default.
 */
export async function shutDownAllSimulators(
  ask: (names: string[]) => Promise<boolean> = askShutDownAll
): Promise<{ done: string[]; declined: boolean }> {
  const devices = await scanSimulators()
  const running = devices.filter((d) => d.state === 'Booted' || d.state === 'Booting')
  if (!running.length) return { done: [], declined: false }
  if (!(await ask(running.map((d) => d.name)))) return { done: [], declined: true }
  const done: string[] = []
  for (const d of running) {
    releaseSimulatorHelpers(d.udid)
    await run('xcrun', ['simctl', 'shutdown', d.udid], { timeout: 60_000 }).then(
      () => done.push(d.name),
      () => {}
    )
  }
  healthLog(`all simulators shut down on request (${done.length} of ${running.length})`)
  return { done, declined: false }
}

/**
 * "Delete these simulators", for an agent the person asked to. Only ones the clean-up
 * rules call removable (never running, held, kept or Apple's own) and only after a
 * yes in the app's own dialog.
 */
export async function deleteSimulatorsWithConsent(
  ask: (names: string[]) => Promise<boolean> = askDeleteSimulators
): Promise<{ deleted: number; freedBytes: number; declined: boolean; names: string[] }> {
  const devices = await scanSimulators()
  const ctx = await context(devices)
  if (!ctx.stockKnown) return { deleted: 0, freedBytes: 0, declined: false, names: [] }
  const rows = describeSimulators(devices, ctx).filter((r) => r.removable)
  if (!rows.length) return { deleted: 0, freedBytes: 0, declined: false, names: [] }
  const names = rows.map((r) => r.name)
  if (!(await ask(names))) return { deleted: 0, freedBytes: 0, declined: true, names }
  const r = await deleteSimulators(rows.map((x) => x.udid))
  return { ...r, declined: false, names }
}

async function askDeleteSimulators(names: string[]): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    type: 'question' as const,
    buttons: ['Cancel', 'Delete them'],
    defaultId: 0,
    cancelId: 0,
    message: `Delete ${names.length} unused simulator${names.length === 1 ? '' : 's'}?`,
    detail:
      'Shut down, not in use by any conversation, not marked Keep. Their apps and data go.\n\n' +
      names.slice(0, 12).join('\n') +
      (names.length > 12 ? `\n… and ${names.length - 12} more` : '')
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return response === 1
}

async function askShutDownAll(names: string[]): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const options = {
    type: 'question' as const,
    buttons: ['Cancel', 'Turn them all off'],
    defaultId: 0,
    cancelId: 0,
    message: `Turn off ${names.length} running simulator${names.length === 1 ? '' : 's'}?`,
    detail:
      'Includes the ones other conversations are using; anything running in them stops.\n\n' +
      names.slice(0, 12).join('\n') +
      (names.length > 12 ? `\n… and ${names.length - 12} more` : '')
  }
  const { response } = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options)
  return response === 1
}

let sleepTimer: NodeJS.Timeout | null = null
const SLEEP_EVERY_MS = 60 * 1000

let timer: NodeJS.Timeout | null = null
/** Soon after launch (which also fixes the baseline), then every six hours. */
export function startSimCleanup(): void {
  if (timer) return
  if (process.env.COVE_USER_DATA) return
  const tick = (): void => {
    void autoCleanSimulators()
      .catch(() => [])
      .finally(() => {
        timer = setTimeout(tick, EVERY_MS)
        timer.unref()
      })
  }
  timer = setTimeout(tick, FIRST_MS)
  timer.unref()
  // Every minute: simulators conversations booted and left go after ten.
  sleepTimer = setInterval(() => void sleepIdleSimulators().catch(() => []), SLEEP_EVERY_MS)
  sleepTimer.unref()
}

export function registerSimCleanupIpc(): void {
  ipcMain.handle('sim:cleanup-state', () => simCleanupState().catch(() => null))
  ipcMain.handle('sim:cleanup-delete', (_e, udids: unknown) =>
    deleteSimulators(
      Array.isArray(udids) ? udids.filter((u): u is string => typeof u === 'string') : []
    )
  )
  ipcMain.handle('sim:cleanup-keep', (_e, udid: unknown, on: unknown) =>
    typeof udid === 'string' && /^[0-9A-F-]{36}$/i.test(udid)
      ? setSimKept(udid.toUpperCase(), on === true)
      : []
  )
  ipcMain.handle('sim:cleanup-auto', (_e, on: unknown) => {
    kvSet(AUTO_KEY, on ? '1' : '0')
    return autoCleanOn()
  })
}
