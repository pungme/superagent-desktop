/**
 * How much of an account's allowance is used, in the words Settings shows:
 * "5-hour 48%, resets 6 PM", "Weekly 86%, resets Mon".
 *
 * Read from three places, all of them the CLIs' own numbers:
 *
 *  - Claude reports its windows on every turn (`rate_limit_event`, whose
 *    `unifiedWindows` carry utilization 0–1 per window). Every account, a
 *    setup-token one included, so a chat keeps its account's numbers current.
 *  - Claude's login can also be asked outright, the way `/usage` does
 *    (`/api/oauth/usage`, utilization 0–100) — which is what Settings does on
 *    opening, so the numbers are there before any chat has run.
 *  - Codex answers `account/rateLimits/read`, and sends the same shape as
 *    `account/rateLimits/updated` while a chat runs: a primary and secondary
 *    window, each with its length in minutes and a percent used.
 *
 * Nothing here reaches the network or a CLI; accounts.ts does that.
 */

export interface UsageWindow {
  /** "5-hour", "Weekly", "Weekly Opus". */
  label: string
  /** 0–100, rounded. */
  percent: number
  /** Epoch ms when the window starts over, if known. */
  resetsAt: number | null
}

export interface Usage {
  windows: UsageWindow[]
  /** Epoch ms the numbers were read. */
  at: number
}

const CLAUDE_WINDOWS: [key: string, label: string][] = [
  ['five_hour', '5-hour'],
  ['seven_day', 'Weekly'],
  ['seven_day_opus', 'Weekly Opus'],
  ['seven_day_sonnet', 'Weekly Sonnet']
]

/** Seconds, milliseconds or an ISO date → epoch ms. */
function resetTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : null
  }
  return null
}

const clampPercent = (n: number): number => Math.max(0, Math.min(100, Math.round(n)))

/** The windows of a Claude `rate_limit_event`, or null for any other event. */
export function usageFromClaudeEvent(
  event: Record<string, unknown>,
  now = Date.now()
): Usage | null {
  if (event.type !== 'rate_limit_event') return null
  const info = event.rate_limit_info as
    | {
        unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>
        utilization?: number
        resetsAt?: number
        rateLimitType?: string
      }
    | undefined
  if (!info) return null
  const windows: UsageWindow[] = []
  for (const [key, label] of CLAUDE_WINDOWS) {
    const w = info.unifiedWindows?.[key]
    if (w && typeof w.utilization === 'number')
      windows.push({
        label,
        percent: clampPercent(w.utilization * 100),
        resetsAt: resetTime(w.resetsAt)
      })
  }
  // An older CLI names only the window it is warning about.
  if (!windows.length && typeof info.utilization === 'number') {
    const label = CLAUDE_WINDOWS.find(([k]) => k === info.rateLimitType)?.[1]
    if (label)
      windows.push({
        label,
        percent: clampPercent(info.utilization * 100),
        resetsAt: resetTime(info.resetsAt)
      })
  }
  return windows.length ? { windows, at: now } : null
}

/** The answer of Claude's `/api/oauth/usage`. */
export function usageFromClaudeApi(body: unknown, now = Date.now()): Usage | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<
    string,
    { utilization?: number | null; resets_at?: string | null } | null
  >
  const windows: UsageWindow[] = []
  for (const [key, label] of CLAUDE_WINDOWS) {
    const w = b[key]
    if (w && typeof w.utilization === 'number')
      windows.push({
        label,
        percent: clampPercent(w.utilization),
        resetsAt: resetTime(w.resets_at)
      })
  }
  return windows.length ? { windows, at: now } : null
}

/** "5-hour" for 300 minutes, "Weekly" for 10080, "2-day" for 2880. */
function windowLabel(mins: unknown): string | null {
  if (typeof mins !== 'number' || mins <= 0) return null
  if (mins === 10080) return 'Weekly'
  if (mins % 1440 === 0) return `${mins / 1440}-day`
  if (mins % 60 === 0) return `${mins / 60}-hour`
  return `${mins}-minute`
}

/**
 * Codex's rate limits — the `rateLimits` of `account/rateLimits/read` or of an
 * `account/rateLimits/updated` notification.
 */
export function usageFromCodex(rateLimits: unknown, now = Date.now()): Usage | null {
  if (!rateLimits || typeof rateLimits !== 'object') return null
  const r = rateLimits as Record<
    string,
    { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | null | undefined
  >
  const windows: UsageWindow[] = []
  for (const [key, fallback] of [
    ['primary', '5-hour'],
    ['secondary', 'Weekly']
  ] as const) {
    const w = r[key]
    if (w && typeof w.usedPercent === 'number')
      windows.push({
        label: windowLabel(w.windowDurationMins) ?? fallback,
        percent: clampPercent(w.usedPercent),
        resetsAt: resetTime(w.resetsAt)
      })
  }
  return windows.length ? { windows, at: now } : null
}
