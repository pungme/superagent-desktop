/**
 * Claude Code nudges its own agent when a turn has gone quiet for a while —
 * "The user hasn't heard from you in a while — say in a few words what you're
 * doing, then continue." — and the line can come back at the head of the
 * agent's reply. It is the CLI talking to the model, not anything the user or
 * the agent said to the user, so it is taken off before a reply is shown.
 */
const NUDGE =
  /^\s*The user hasn['’]t heard from you in a while\s*[—–-]+\s*say in a few words what you['’]re doing, then continue\.?\s*/i

export function withoutAgentNudge(text: string): string {
  return text.replace(NUDGE, '')
}
