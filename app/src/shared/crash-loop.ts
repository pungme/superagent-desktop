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
}

/** The device and time out of a SpringBoard-*.ips report (a header line, then JSON). */
export function parseSpringBoardCrash(text: string): SpringBoardCrash | null {
  const nl = text.indexOf('\n')
  if (nl < 0) return null
  try {
    const j = JSON.parse(text.slice(nl + 1)) as {
      procName?: string
      coalitionName?: string
      captureTime?: string
    }
    if (j.procName !== 'SpringBoard') return null
    const m = /SimDevice\.([0-9A-Fa-f-]{36})$/.exec(j.coalitionName ?? '')
    if (!m) return null
    // "2026-11-19 17:59:33.7987 +0100" -> an ISO date JS can read.
    const iso = (j.captureTime ?? '').replace(' ', 'T').replace(/ ([+-])(\d\d)(\d\d)$/, '$1$2:$3')
    const at = Date.parse(iso)
    return Number.isNaN(at) ? null : { udid: m[1].toUpperCase(), at }
  } catch {
    return null
  }
}

export const LOOP_WINDOW_MS = 90_000
export const LOOP_MIN_CRASHES = 4
/** Not twice for one device inside this: a restart that did not help is not tried again at once. */
export const LOOP_COOLDOWN_MS = 10 * 60_000
/** Only a loop still going: the latest crash this recent. */
export const LOOP_ACTIVE_MS = 30_000

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
