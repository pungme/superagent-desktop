/**
 * Clearing out simulators nobody is using. Agents create simulators ("Fold Audit",
 * "iPhone Duo (11)") and never delete them; each one is 2 to 14 GB, and 16 of them
 * were 95 GB. The rules live here, free of simctl, so every reason to keep a device
 * is tested.
 *
 * Two ways to go: the person picks from a list in Settings (any device that is not
 * running and that no conversation holds), or, with the switch on, a device that is
 * shut down, held by nobody, not Apple's own (named for a device type), not marked
 * Keep, and unused for three days. It used to spare whatever was there when
 * Superagent first looked; that was most of a Mac where agents had been making
 * simulators for weeks (17 of 20), so the clean-up never reached them.
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

export type SimKeep = 'running' | 'held' | 'kept' | 'stock' | 'recent' | null

export interface SimRow extends SimInfo {
  /** Why it will not be cleared automatically; null when it will, once idle long enough. */
  keep: SimKeep
  /** Whether it can be removed by hand: not running, not held by a conversation. */
  removable: boolean
}

export const IDLE_DAYS = 3
export const IDLE_MS = IDLE_DAYS * 24 * 60 * 60 * 1000

export interface PlanContext {
  now: number
  /** Devices a conversation holds or has open: never removed. */
  held: ReadonlySet<string>
  /** UDIDs the person marked Keep: never removed. */
  kept: ReadonlySet<string>
  /** Names (lower case) of Apple's own device types: a device with exactly one is a stock one. */
  stock: ReadonlySet<string>
  idleMs?: number
}

function keepReason(d: SimInfo, c: PlanContext): SimKeep {
  if (d.state !== 'Shutdown') return 'running'
  if (c.held.has(d.udid)) return 'held'
  if (c.kept.has(d.udid)) return 'kept'
  // Xcode's own devices carry a device type's name ("iPhone 17"); anything an agent
  // made has a name of its own ("Fold Audit", "iPhone Duo (11)").
  if (c.stock.has(d.name.trim().toLowerCase())) return 'stock'
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

/**
 * The simulators to shut down when Superagent quits: every one a conversation
 * has had or has open, once each. Nothing else: a simulator the person started
 * in Xcode is theirs. Only real UDIDs, as they go on a command line.
 */
export function simulatorsToShutDown(...lists: Iterable<string>[]): string[] {
  const out = new Set<string>()
  for (const list of lists)
    for (const udid of list)
      if (/^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i.test(udid))
        out.add(udid.toUpperCase())
  return [...out]
}

/** How long a conversation's simulator may sit unused before it is shut down. */
export const SIM_IDLE_MS = 10 * 60 * 1000

export interface SleepContext {
  /** The simulators booted now. */
  booted: string[]
  /** The conversation that has a simulator, if any. */
  ownerOf: (udid: string) => string | null
  /** The simulators there at Superagent's first look: the person's own. */
  baseline: Set<string>
  /** Shown in a pane right now. */
  shown: Set<string>
  /** Whether a conversation's agent is running. */
  agentRunning: (chatId: string) => boolean
  /** When each simulator was first seen unused; kept between sweeps. */
  idleSince: Map<string, number>
  now: number
  idleMs?: number
}

/**
 * The booted simulators to shut down now. Each holds a whole iOS (some 230
 * processes): booted by an agent and then left, they piled up into the
 * thousands. One goes when it is Superagent's (a conversation has it, or it was
 * made since the first look), no pane shows it, no agent of its conversation
 * is running, and that has held for the idle time. A simulator the person
 * started themselves is never touched.
 */
export function simulatorsToSleep(c: SleepContext): string[] {
  const idleMs = c.idleMs ?? SIM_IDLE_MS
  const out: string[] = []
  const booted = new Set(c.booted)
  for (const udid of [...c.idleSince.keys()]) if (!booted.has(udid)) c.idleSince.delete(udid)
  for (const udid of c.booted) {
    const owner = c.ownerOf(udid)
    const ours = owner !== null || !c.baseline.has(udid)
    const inUse = c.shown.has(udid) || (owner !== null && c.agentRunning(owner))
    if (!ours || inUse) {
      c.idleSince.delete(udid)
      continue
    }
    const since = c.idleSince.get(udid)
    if (since === undefined) c.idleSince.set(udid, c.now)
    else if (c.now - since >= idleMs) out.push(udid)
  }
  return out
}
