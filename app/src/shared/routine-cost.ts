/**
 * What a routine costs, from what its runs really used.
 *
 * Only measured numbers: a routine that has not run has no estimate (a guess
 * would read as a fact). The typical run is the average of its latest runs that
 * used tokens, so one odd run does not set the figure.
 */

export interface RunSample {
  status: string
  tokens: number
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
/** How many of the latest runs the typical run is taken from. */
export const TYPICAL_RUNS = 5

/** Tokens a typical run uses; null until a run has been measured. Newest run first. */
export function typicalRunTokens(runs: RunSample[]): number | null {
  const used = runs.filter((r) => r.tokens > 0).slice(0, TYPICAL_RUNS)
  if (!used.length) return null
  return Math.round(used.reduce((n, r) => n + r.tokens, 0) / used.length)
}

/** Runs in a week at this interval. */
export function runsPerWeek(intervalMs: number): number {
  return intervalMs > 0 ? WEEK_MS / intervalMs : 0
}

/** Tokens a week at this interval, from the typical run; null when it was never measured. */
export function weeklyTokens(runs: RunSample[], intervalMs: number, enabled = true): number | null {
  if (!enabled) return 0
  const typical = typicalRunTokens(runs)
  return typical === null ? null : Math.round(typical * runsPerWeek(intervalMs))
}

/** "850", "42k", "1.9M". */
export function compactTokens(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000)
    return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

/**
 * What changing the interval would do to the week: the same typical run, run
 * more or less often. null when there is nothing measured to compare.
 */
export function savingsFor(
  runs: RunSample[],
  fromMs: number,
  toMs: number
): { before: number; after: number; saved: number } | null {
  const before = weeklyTokens(runs, fromMs)
  const after = weeklyTokens(runs, toMs)
  if (before === null || after === null) return null
  return { before, after, saved: before - after }
}

/** Failed runs first, then running, then the rest by next run: what to look at first. */
export function attentionOrder<
  T extends { lastRunStatus: string | null; nextRunAt: number; enabled: number }
>(routines: T[]): T[] {
  const rank = (r: T): number =>
    r.lastRunStatus === 'error' ? 0 : r.lastRunStatus === 'running' ? 1 : r.enabled ? 2 : 3
  return [...routines].sort((a, b) => rank(a) - rank(b) || a.nextRunAt - b.nextRunAt)
}
