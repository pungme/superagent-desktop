import { execFile } from 'child_process'
import { parseBattery, type BatteryState } from '../../shared/battery-floor'
import type { WireBattery } from '../../shared/companion-protocol'

/**
 * The Mac's battery for the phone, beside the Mac's name. Read with the same
 * `pmset -g batt` the lid-closed floor uses; a Mac with no battery (a desktop)
 * says nothing, so the phone shows no level for it.
 */

const PMSET = '/usr/bin/pmset'
/** How often it is looked at while a phone is connected. */
const EVERY_MS = 60_000

export function toWireBattery(b: BatteryState): WireBattery | null {
  return b.percent === null ? null : { percent: b.percent, pluggedIn: b.onPower }
}

/** A test run has no battery to read: COVE_E2E_BATTERY="55" or "55:plugged" stands in for one. */
function fake(): WireBattery | null | undefined {
  const v = process.env.COVE_E2E_BATTERY
  if (v === undefined) return undefined
  const m = /^(\d{1,3})(:plugged)?$/.exec(v)
  return m ? { percent: Number(m[1]), pluggedIn: !!m[2] } : null
}

export function readWireBattery(): Promise<WireBattery | null> {
  const f = fake()
  if (f !== undefined) return Promise.resolve(f)
  if (process.platform !== 'darwin' || process.env.COVE_USER_DATA) return Promise.resolve(null)
  return new Promise((resolve) =>
    execFile(PMSET, ['-g', 'batt'], { timeout: 5000 }, (_e, out) =>
      resolve(toWireBattery(parseBattery(String(out ?? ''))))
    )
  )
}

const same = (a: WireBattery | null, b: WireBattery | null): boolean =>
  a === b || (!!a && !!b && a.percent === b.percent && a.pluggedIn === b.pluggedIn)

let last: WireBattery | null = null
let timer: ReturnType<typeof setInterval> | null = null

/** A reading taken elsewhere (a phone just connected), so the watcher only tells of changes. */
export function noteBattery(b: WireBattery | null): void {
  last = b
}

/** Look now; `push` is called when the level or the plug changed. */
export async function checkBattery(push: (b: WireBattery | null) => void): Promise<void> {
  const b = await readWireBattery()
  if (same(b, last)) return
  last = b
  push(b)
}

/** Keep looking, but only while a phone is there to see it. */
export function watchBattery(phones: () => number, push: (b: WireBattery | null) => void): void {
  if (timer) return
  timer = setInterval(() => {
    if (phones() > 0) void checkBattery(push)
  }, EVERY_MS)
  timer.unref()
}
