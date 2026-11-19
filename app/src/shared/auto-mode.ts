/**
 * Auto mode: when the agent finishes a turn, ask it whether anything is left and,
 * if so, let it carry on, until it says it is done. Per chat, off by default.
 *
 * `autoNext` is the whole decision, kept free of the window so every reason to
 * stop is tested. The rule of thumb: Auto never talks over a person. Anything
 * that waits on you, anything you did, and anything odd stops it.
 */

/** What is sent, as if typed. The sentinel is how the agent says it is finished. */
export const AUTO_DONE = 'AUTO_DONE'
export const AUTO_PROMPT =
  'Auto mode: is there anything else left to do on this task? If there is, do the next ' +
  'thing now. If you need a decision or something from me, ask me and stop. If everything ' +
  `is finished, reply with exactly ${AUTO_DONE} and nothing else.`

/** Rounds in a row, from one thing the person wrote. Then it waits for them. */
export const AUTO_MAX_ROUNDS = 6

export interface AutoState {
  on: boolean
  /** Auto rounds already sent since the person last wrote. */
  rounds: number
  /** The agent's last reply, in plain text ('' when there is none). */
  lastReply: string
  /** The last thing in the conversation is a question for the person. */
  askedQuestion: boolean
  /** A permission, connector or limit prompt is open. */
  needsYou: boolean
  /** The person pressed Stop for this turn. */
  stopped: boolean
  /** The turn ended in an error. */
  failed: boolean
  /** Messages the person queued to send when it is done. */
  queued: number
  /** Something is typed in the box. */
  typing: boolean
  /** The agent is ready to take a message. */
  ready: boolean
}

export type AutoDecision = { send: true } | { send: false; why: AutoWhy }

export type AutoWhy =
  | 'off'
  | 'done'
  | 'question'
  | 'needs-you'
  | 'stopped'
  | 'failed'
  | 'queued'
  | 'typing'
  | 'limit'
  | 'busy'
  | 'empty'

/** Whether a reply is the agent saying it is finished. */
export function saidDone(reply: string): boolean {
  return (
    reply
      .trim()
      .split('\n')[0]
      ?.trim()
      .replace(/[.!*`]/g, '') === AUTO_DONE
  )
}

/** Whether a reply ends by asking the person something. */
export function endsWithQuestion(reply: string): boolean {
  const t = reply.trim().replace(/[`*_)\]\s]+$/g, '')
  return t.endsWith('?') || t.endsWith('？')
}

export function autoNext(s: AutoState): AutoDecision {
  if (!s.on) return { send: false, why: 'off' }
  if (s.stopped) return { send: false, why: 'stopped' }
  if (s.failed) return { send: false, why: 'failed' }
  if (s.needsYou) return { send: false, why: 'needs-you' }
  if (s.askedQuestion || endsWithQuestion(s.lastReply)) return { send: false, why: 'question' }
  if (s.queued > 0) return { send: false, why: 'queued' }
  if (s.typing) return { send: false, why: 'typing' }
  if (!s.ready) return { send: false, why: 'busy' }
  if (!s.lastReply.trim()) return { send: false, why: 'empty' }
  if (saidDone(s.lastReply)) return { send: false, why: 'done' }
  if (s.rounds >= AUTO_MAX_ROUNDS) return { send: false, why: 'limit' }
  return { send: true }
}
