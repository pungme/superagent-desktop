/**
 * The in-chat `/loop`: re-run a prompt in the same conversation until stopped,
 * like the terminal's. Parsed and run on the Mac's main process (see
 * main/loops.ts) so the window and the phone see — and can stop — the same loop.
 *
 * Shared between main and renderer, so no Electron or Node imports.
 */

/** Safety cap so a loop can't run away forever. */
export const LOOP_CAP = 100
/**
 * A terminal's self-paced /loop is the model calling ScheduleWakeup, clamped
 * to [60, 3600] seconds by the CLI's own runtime — Superagent disallows that
 * tool (it works by asking whatever runs the CLI to relaunch the process
 * later, which only exists for an interactive terminal, not a spawned agent
 * process) and gives loop_wait instead: same shape, same clamp, but Superagent
 * itself holds the wait and resubmits. DEFAULT_LOOP_ROUND_GAP_MS is what
 * applies when the model doesn't call it at all — the same floor a bare
 * ScheduleWakeup call would hit, so a round that does nothing still doesn't
 * fire "immediately."
 */
export const DEFAULT_LOOP_ROUND_GAP_MS = 60_000
export const MAX_LOOP_ROUND_GAP_MS = 3_600_000
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

export type LoopCommand =
  | { kind: 'stop' }
  | { kind: 'usage' }
  | { kind: 'start'; intervalMs: number | null; prompt: string }

/** Whether a message is a /loop command at all. */
export function isLoopCommand(raw: string): boolean {
  return /^\/loop(\s|$)/i.test(raw.trim())
}

/**
 * Parse a `/loop` command like the terminal's: `/loop <prompt>` runs the prompt
 * again each time the turn finishes; `/loop 5m <prompt>` (or `<prompt> every 5
 * minutes`) runs it on that interval; `/loop stop` ends it. Null if it isn't a
 * /loop command.
 */
export function parseLoopCmd(raw: string): LoopCommand | null {
  const m = /^\/loop\b\s*(.*)$/is.exec(raw.trim())
  if (!m) return null
  const body = m[1].trim()
  if (!body) return { kind: 'usage' }
  if (/^stop$/i.test(body)) return { kind: 'stop' }
  const lead = /^(\d+)\s*([smhd])\s+(.+)$/is.exec(body)
  if (lead)
    return {
      kind: 'start',
      intervalMs: Number(lead[1]) * UNIT_MS[lead[2].toLowerCase()],
      prompt: lead[3].trim()
    }
  const trail =
    /^(.+?)\s+every\s+(\d+)\s*(s|m|h|d|sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days)$/is.exec(
      body
    )
  if (trail) {
    const u = trail[3].toLowerCase()[0] as 's' | 'm' | 'h' | 'd'
    return { kind: 'start', intervalMs: Number(trail[2]) * UNIT_MS[u], prompt: trail[1].trim() }
  }
  return { kind: 'start', intervalMs: null, prompt: body }
}

/**
 * A no-interval /loop hands the cadence to the model, as the terminal's does
 * — in a terminal that's a ScheduleWakeup call. Superagent disallows that tool
 * (see session.ts for why) and points the model at loop_wait instead: the same
 * call, the same clamp, answered by Superagent's own timer.
 */
export const SELF_PACE_NOTE =
  '\n\n(/loop, self-paced: pick your own pace with the loop_wait tool, exactly as you would call ' +
  "ScheduleWakeup in a terminal — clamped to [60, 3600]s. Don't bother for a short, ~60s gap; " +
  'Superagent already waits that long by default. Call it once, before ending the turn, when this ' +
  "round's wait should be longer than that. Keep rounds brief; the loop runs until stopped.)"

export const LOOP_USAGE =
  'Usage: /loop [5m·2h·…] <prompt> — repeats the prompt in this chat until you Stop it. `/loop stop` ends it.'

export function humanInterval(ms: number): string {
  if (ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d}d`
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`
  return `${Math.round(ms / 1000)}s`
}
