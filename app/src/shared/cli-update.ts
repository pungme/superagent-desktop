/** What `claude update` printed, as far as the app cares. */
export interface CliUpdateResult {
  /** Installed after the run (from the output), when it said. */
  version: string | null
  /** The version it moved from; set only when it installed something. */
  from: string | null
  updated: boolean
}

/**
 * "Current version: 2.1.314" … "Successfully updated from 2.1.314 to version
 * 2.1.325" (or "Claude Code is up to date"). Anything it did not say is left out.
 */
export function parseCliUpdate(out: string): CliUpdateResult {
  const done = /updated from ([\d.]+) to (?:version )?([\d.]+)/i.exec(out)
  if (done) return { version: done[2], from: done[1], updated: true }
  const current = /(?:current version|up to date)[^\d]*([\d]+\.[\d.]+)/i.exec(out)
  return { version: current?.[1] ?? null, from: null, updated: false }
}

/** How long after the app opens it first looks, and how often it looks again. */
export const CLI_UPDATE_FIRST_MS = 90_000
export const CLI_UPDATE_EVERY_MS = 12 * 60 * 60 * 1000
