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
  | { kind: 'pause' }
  | { kind: 'resume' }
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
  if (/^pause$/i.test(body)) return { kind: 'pause' }
  if (/^(resume|continue)$/i.test(body)) return { kind: 'resume' }
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
 * When a loop is over, said to the agent with every round.
 *
 * The first wording ("when it has done its job, or another round cannot help,
 * end it yourself") was read as leave to stop at the first quiet moment: an
 * agent asked to keep improving something finished its own list in a round or
 * two and ended the loop. Someone who starts a loop wants the rounds, so the
 * default is the other way: finishing what was planned is the cue to look for
 * the next thing, and ending is for when there is truly nothing left to do.
 */
const LOOP_KEEP_GOING =
  'The user started a loop because they want it to keep going, so each round, do the next ' +
  'useful thing. Finishing what you had planned is not the end of the loop: look again at what ' +
  'was asked and find what is still weak, untested, unverified, unpolished or not yet tried, ' +
  'and do that. End it yourself with the loop_stop tool only when a specific thing it was ' +
  'waiting for has happened and nothing follows from it, when it cannot move without the user, ' +
  'or when you have honestly looked for more to do, more than once, and found nothing worth a ' +
  'round. When unsure, keep going.'

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
  "round's wait should be longer than that. Keep rounds brief. " +
  LOOP_KEEP_GOING +
  ')'

/** Sent with a round of a loop on a fixed interval: the one thing it needs to know. */
export const LOOP_STOP_NOTE =
  '\n\n(/loop: this repeats on a timer until it is stopped. ' + LOOP_KEEP_GOING + ')'

export const LOOP_USAGE =
  'Usage: /loop [5m·2h·…] <prompt> — repeats the prompt in this chat until you Stop it. `/loop pause` and `/loop resume` hold and continue it; `/loop stop` ends it.'

export function humanInterval(ms: number): string {
  if (ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d}d`
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`
  return `${Math.round(ms / 1000)}s`
}
