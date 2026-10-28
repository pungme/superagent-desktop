import {
  app,
  BrowserWindow,
  ipcMain,
  MessageChannelMain,
  utilityProcess,
  type UtilityProcess
} from 'electron'
import { healthLog } from './health'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import * as core from './sim-hid-core'
import type { HidAction, HidResult } from './sim-hid-core'

export type { HidAction, HidResult } from './sim-hid-core'
export { hidCommand, modifierUsages, normalise, KEY_USAGES, BUTTON_USAGES } from './sim-hid-core'

const run = promisify(execFile)

/**
 * Input for the simulator the way Xcode 27 takes it: `native/siminput`, driven
 * from a process of its own (sim-input-worker.ts) so that neither the pane's
 * fingers nor the agent's taps wait behind whatever main is doing. Should that
 * process not start, main drives siminput itself, as it used to.
 */

export function siminputPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'siminput')]
    : [join(__dirname, '../../native/siminput'), join(process.cwd(), 'native/siminput')]
  return candidates.find((p) => existsSync(p)) ?? null
}

let worker: UtilityProcess | null = null
let quitting = false
let workerFailed = false
let nextId = 1
const pending = new Map<number, (result: unknown) => void>()

function inputProcess(): UtilityProcess | null {
  if (worker) return worker
  if (workerFailed) return null
  const script = join(__dirname, 'sim-input-worker.js')
  if (!existsSync(script)) {
    workerFailed = true
    return null
  }
  try {
    const w = utilityProcess.fork(script, [], { serviceName: 'Superagent Simulator Input' })
    w.postMessage({ op: 'init', bin: siminputPath() })
    w.on('message', (m: { id?: number; result?: unknown; log?: string }) => {
      if (typeof m?.log === 'string') healthLog(`sim input: ${m.log}`)
      if (typeof m?.id !== 'number') return
      const done = pending.get(m.id)
      pending.delete(m.id)
      done?.(m.result)
    })
    w.on('exit', (code) => {
      if (worker === w) worker = null
      for (const done of pending.values()) done(null)
      pending.clear()
      // The windows hold a line straight to this process; it is dead now, and
      // every touch sent down it would wait forever. Tell them to ask again:
      // the next one starts a fresh process.
      if (!quitting)
        healthLog(`CRASH sim input process exited (code ${code}); restarting on the next touch`)
      for (const win of BrowserWindow.getAllWindows())
        if (!win.isDestroyed()) win.webContents.send('sim:input-port-lost')
    })
    worker = w
    return w
  } catch (err) {
    console.log('[siminput] no input process, driving it from main:', String(err))
    workerFailed = true
    return null
  }
}

function ask<T>(msg: Record<string, unknown>, fallback: () => Promise<T>): Promise<T> {
  const w = inputProcess()
  if (!w) return fallback()
  return new Promise<T>((resolve) => {
    const id = nextId++
    pending.set(id, (r) => resolve(r as T))
    w.postMessage({ ...msg, id })
  })
}

/**
 * Send an action through dtuhidd. Null when this path does not apply (no
 * helper, an older Xcode, an action it does not take): the caller uses the old
 * path then. A result when it was tried, even if it failed.
 */
export function sendHid(udid: string, action: HidAction): Promise<HidResult | null> {
  return ask({ op: 'send', udid, action }, () => core.sendHidWith(siminputPath(), udid, action))
}

/**
 * Whether this device takes input through dtuhidd: then the pane can send a
 * finger down, moving and up as it happens instead of whole swipes.
 */
export function hidReady(udid: string): Promise<boolean> {
  return ask({ op: 'ready', udid }, () => core.hidReadyWith(siminputPath(), udid))
}

export function endHidSession(udid: string): void {
  if (worker) worker.postMessage({ op: 'end', udid, id: nextId++ })
  core.endHidSession(udid)
}

export function stopAllHid(): void {
  quitting = true
  if (worker) {
    worker.postMessage({ op: 'stop', id: nextId++ })
    worker.kill()
    worker = null
  }
  core.stopAllHid()
}

/**
 * The pane's own line to the input process, so a finger on the simulator never
 * queues behind main. Asked for once per window; main only makes the
 * introduction.
 */
export function registerSimInputPort(): void {
  ipcMain.on('sim:input-port', (e) => {
    const w = inputProcess()
    if (!w) return
    const { port1, port2 } = new MessageChannelMain()
    w.postMessage({ op: 'port' }, [port1])
    e.sender.postMessage('sim:input-port', null, [port2])
  })
}

/** Whether this machine can use the dtuhidd path at all (a helper, an Xcode with dtuhidd). */
export async function hidAvailable(): Promise<boolean> {
  if (!siminputPath()) return false
  try {
    const { stdout } = await run('xcrun', ['simctl', 'help'], { timeout: 10_000 })
    return stdout.length > 0
  } catch {
    return false
  }
}
