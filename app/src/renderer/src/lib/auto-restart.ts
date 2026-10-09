/**
 * When a chat restarts its own agent session after it ended unasked
 * (EasyChat's autoRestartRef).
 *
 * Three times in ten minutes, then the banner and its Retry button: a session
 * that dies every time it starts (signed out, a broken install) must not be
 * respawned for ever, and the person needs to be told.
 */
export const AUTO_RESTART_WINDOW_MS = 10 * 60_000
export const AUTO_RESTART_MAX = 3

/** Whether to restart once more, given how many restarts the window already holds. */
export function shouldAutoRestart(recentRestarts: number): boolean {
  return recentRestarts < AUTO_RESTART_MAX
}

/** Sent to a session restarted mid-reply. It resumes with the conversation, not with the turn. */
export const CARRY_ON_NUDGE =
  '(Superagent: your session ended unexpectedly in the middle of your last reply and has been ' +
  'restarted. Nothing the user said is missing. Check what you had already done, then carry on ' +
  'from where you were cut off.)'
