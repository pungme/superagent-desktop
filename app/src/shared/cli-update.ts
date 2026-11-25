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

/** The first x.y.z in what `<cli> --version` printed ("codex-cli 0.46.0", "1.5.17", "2.1.325 (Claude Code)"). */
export function versionOf(out: string): string | null {
  return /(\d+\.\d+\.\d+(?:[-.][0-9A-Za-z]+)*)/.exec(out)?.[1] ?? null
}

/**
 * How to update Codex, from where the `codex` on the PATH really is (its real
 * path, links followed). It has no updater of its own, so it is updated the way
 * it was installed — and left alone when that is not known, rather than a
 * second copy installed beside one the user put there some other way.
 */
export type CodexInstall = 'npm' | 'brew' | 'other'

export function codexInstallKind(realPath: string): CodexInstall {
  if (/\/node_modules\//.test(realPath)) return 'npm'
  if (/\/(Cellar|Caskroom)\//.test(realPath)) return 'brew'
  return 'other'
}

export const CODEX_UPDATE_COMMAND: Record<Exclude<CodexInstall, 'other'>, string> = {
  npm: 'npm install -g @openai/codex@latest',
  brew: 'brew upgrade codex'
}

/** Which agents are kept up to date, in the order they are looked at. */
export const UPDATED_CLIS = ['claude', 'codex', 'antigravity'] as const
export type UpdatedCli = (typeof UPDATED_CLIS)[number]

/** One agent's CLI as the last look found it. */
export interface CliInfo {
  /** What `--version` says, or null when it is not installed. */
  version: string | null
  /** When the last look finished (ms), or 0 before the first. */
  checkedAt: number
  /** Installed by the last look: "0.46.0 → 0.47.1". */
  updatedFrom: string | null
  running: boolean
  error: string | null
  /** Why it is not updated by Superagent (installed some way it does not know). */
  skipped: string | null
}
