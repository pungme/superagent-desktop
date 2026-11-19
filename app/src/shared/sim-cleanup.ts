/**
 * Clearing out simulators nobody is using. Agents create simulators ("Fold Audit",
 * "iPhone Duo (11)") and never delete them; each one is 2 to 14 GB, and 16 of them
 * were 95 GB. The rules live here, free of simctl, so every reason to keep a device
 * is tested.
 *
 * Two ways to go: the person picks from a list in Settings (any device that is not
 * running and that no conversation holds), or, with the switch on, devices that
 * appeared AFTER Superagent first looked, that are shut down, held by nobody, and
 * unused for a week. What was already there at the first look is the person's own
 * and is only ever removed by hand.
 */

export interface SimInfo {
  udid: string
  name: string
  /** 'Booted', 'Shutdown', 'Booting'… as simctl says. */
  state: string
  sizeBytes: number
  /** When it was last booted or used (ms), or null when simctl does not say. */
  lastUsedAt: number | null
}

export type SimKeep = 'running' | 'held' | 'baseline' | 'recent' | null

export interface SimRow extends SimInfo {
  /** Why it will not be cleared automatically; null when it will, once idle long enough. */
  keep: SimKeep
  /** Whether it can be removed by hand: not running, not held by a conversation. */
  removable: boolean
}

export const IDLE_DAYS = 7
export const IDLE_MS = IDLE_DAYS * 24 * 60 * 60 * 1000

export interface PlanContext {
  now: number
  /** Devices a conversation holds or has open: never removed. */
  held: ReadonlySet<string>
  /** UDIDs present at the first look: the person's own, never removed automatically. */
  baseline: ReadonlySet<string>
  idleMs?: number
}

function keepReason(d: SimInfo, c: PlanContext): SimKeep {
  if (d.state !== 'Shutdown') return 'running'
  if (c.held.has(d.udid)) return 'held'
  if (c.baseline.has(d.udid)) return 'baseline'
  const idle = c.idleMs ?? IDLE_MS
  // No date at all counts as old: a device simctl cannot place was not used lately.
  if (d.lastUsedAt !== null && c.now - d.lastUsedAt < idle) return 'recent'
  return null
}

/** Every device with what may be done to it, biggest first. */
export function describeSimulators(devices: SimInfo[], c: PlanContext): SimRow[] {
  return devices
    .map((d) => ({
      ...d,
      keep: keepReason(d, c),
      removable: d.state === 'Shutdown' && !c.held.has(d.udid)
    }))
    .sort((a, b) => b.sizeBytes - a.sizeBytes)
}

/** What the automatic clean-up would remove right now. */
export function autoCleanup(devices: SimInfo[], c: PlanContext): SimRow[] {
  return describeSimulators(devices, c).filter((r) => r.keep === null)
}

/** "14.3 GB", "820 MB". */
export function sizeLabel(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`
}
