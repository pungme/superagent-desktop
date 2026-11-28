/**
 * A simulator whose SpringBoard crashes again and again (macOS 27 beta: it asserts
 * while setting up displays, then launchd starts it again, 15 times in two minutes).
 * Each crash leaves a report in ~/Library/Logs/DiagnosticReports that names its
 * device. This reads those and says which device needs a restart. Pure: no files,
 * no simctl.
 */

export interface SpringBoardCrash {
  udid: string
  at: number
  /** Which system process crashed (SpringBoard, PosterBoard, backboardd). */
  process: string
}

/**
 * The simulator's own system processes whose crash loops take the device down with them, each
 * with a "quit unexpectedly" pop-up: SpringBoard (macOS 27 beta), then PosterBoard (the lock
 * screen and wallpaper: 18 crashes in two minutes seen on 2026-11-28) and backboardd. An app's
 * own crash is not here: restarting the device for that would only lose the app's state.
 */
export const LOOPING_PROCESSES = ['SpringBoard', 'PosterBoard', 'backboardd'] as const
export const LOOP_REPORT = /^(SpringBoard|PosterBoard|backboardd)-.*\.ips$/

/** The device and time out of a crash report of one of those (a header line, then JSON). */
export function parseSpringBoardCrash(text: string): SpringBoardCrash | null {
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  try {
    const j = JSON.parse(text.slice(nl + 1)) as {
      procName?: string
      coalitionName?: string
      captureTime?: string
    }
    if (!(LOOPING_PROCESSES as readonly string[]).includes(j.procName ?? '')) return null
    const m = /SimDevice\.([0-9A-Fa-f-]{36})$/.exec(j.coalitionName ?? '')
    if (!m) return null
    // "2026-11-19 17:59:33.7987 +0100" -> an ISO date JS can read.
    const iso = (j.captureTime ?? '').replace(' ', 'T').replace(/ ([+-])(\d\d)(\d\d)$/, '$1$2:$3')
    const at = Date.parse(iso)
    return Number.isNaN(at)
      ? null
      : { udid: m[1].toUpperCase(), at, process: j.procName ?? 'A system process' }
  } catch {
    return null
  }
}

export const LOOP_WINDOW_MS = 60_000
export const LOOP_MIN_CRASHES = 3
/** Not twice for one device inside this: a restart that did not help is not tried again at once. */
export const LOOP_COOLDOWN_MS = 10 * 60_000
/** Only a loop still going: the latest crash this recent. */
export const LOOP_ACTIVE_MS = 20_000
/** After a loop, the pop-ups come back once there has been no crash this long. */
export const LOOP_QUIET_MS = 3 * 60_000

/**
 * What to do about each looping device. A first loop: restart it (the usual cure). One that loops
 * again soon after a restart: the restart did not help, so it is shut down and left down (and the
 * person told), because a device that crashes for ever only fills the screen with pop-ups and
 * burns the Mac. Nothing here knows who owns the device: this is the app's guardrail, not an agent's.
 */
export function loopActions(
  crashes: SpringBoardCrash[],
  now: number,
  restartedAt: ReadonlyMap<string, number>,
  stoppedAt: ReadonlyMap<string, number> = new Map()
): { restart: string[]; stop: string[] } {
  const byDevice = new Map<string, number[]>()
  for (const c of crashes) {
    if (now - c.at > LOOP_WINDOW_MS) continue
    byDevice.set(c.udid, [...(byDevice.get(c.udid) ?? []), c.at])
  }
  const restart: string[] = []
  const stop: string[] = []
  for (const [udid, times] of byDevice) {
    if (times.length < LOOP_MIN_CRASHES) continue
    if (now - Math.max(...times) > LOOP_ACTIVE_MS) continue
    const stopped = stoppedAt.get(udid)
    if (stopped !== undefined && now - stopped < LOOP_COOLDOWN_MS) continue
    const last = restartedAt.get(udid)
    if (last === undefined || now - last >= LOOP_COOLDOWN_MS) restart.push(udid)
    // Restarted a moment ago and looping again, with crashes since that restart.
    else if (Math.max(...times) > last) stop.push(udid)
  }
  return { restart, stop }
}

/** Devices to restart now. */
export function loopingDevices(
  crashes: SpringBoardCrash[],
  now: number,
  restartedAt: ReadonlyMap<string, number>
): string[] {
  const byDevice = new Map<string, number[]>()
  for (const c of crashes) {
    if (now - c.at > LOOP_WINDOW_MS) continue
    byDevice.set(c.udid, [...(byDevice.get(c.udid) ?? []), c.at])
  }
  const out: string[] = []
  for (const [udid, times] of byDevice) {
    if (times.length < LOOP_MIN_CRASHES) continue
    if (now - Math.max(...times) > LOOP_ACTIVE_MS) continue
    const last = restartedAt.get(udid)
    if (last !== undefined && now - last < LOOP_COOLDOWN_MS) continue
    out.push(udid)
  }
  return out
}
