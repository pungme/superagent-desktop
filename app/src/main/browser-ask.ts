/**
 * Whether the agent's browser_use('yours') may move a conversation to the
 * user's own browser (Brave, Chrome, Edge) at once, or has to ask first.
 *
 * The agent used to switch by itself whenever it judged a site needed the
 * user's logins, and the user's Brave opened and took the screen without them
 * having asked ("why does the agent switch to Brave all the time"). Now it
 * asks with a card in the chat, and nothing opens until the user taps. No card
 * when the user already chose: this conversation is on their browser (the
 * Browser pill, or an earlier yes), or their own last message asked for it.
 *
 * Pure: no Electron, so the decision and the words are unit-tested as they are.
 */

/** After "Stay here", the agent is not asked about it again for this long. */
export const STAY_MS = 30 * 60_000

/** An unanswered card counts as "Stay here" after this long. */
export const ASK_TIMEOUT_MS = 120_000

export type BrowserUseDecision =
  /** This conversation is on the user's browser already (the pill, or an earlier yes). */
  | 'already'
  /** The user's own last message asked for their browser. */
  | 'asked'
  /** The user said "Stay here" a short while ago: do not ask again yet. */
  | 'stayed'
  /** Show the card and wait for the answer. */
  | 'ask'

export function decideBrowserUse(o: {
  /** This conversation's browser now: 'builtin' or the user's. */
  current: string
  /** The user's last message in this conversation, if one is known. */
  lastUserText: string | undefined
  /** When a remembered "Stay here" runs out (ms), or undefined. */
  stayUntil: number | undefined
  now: number
}): BrowserUseDecision {
  if (o.current !== 'builtin') return 'already'
  // Asking outright beats an earlier "Stay here": they changed their mind.
  if (o.lastUserText && userAskedForTheirBrowser(o.lastUserText)) return 'asked'
  if (o.stayUntil !== undefined && o.now < o.stayUntil) return 'stayed'
  return 'ask'
}

/** A browser named, or "my browser" and its kin. Edge only where it is the
 *  browser: "edge case" is common in a coding chat. */
const ASKS_FOR =
  /\b(brave|chrome|chromium|(microsoft|ms)\s+edge|edge\s+browser|(in|use|open|with|to)\s+edge\b(?!\s+cases?)|(my|own|real|regular|normal|everyday|usual)\s+browser)\b/i
/** "don't use Brave", "not in Chrome", "without my browser", "stay out of Edge". */
const REFUSES =
  /\b(don'?t|do\s+not|never|not|no|without|stop|instead\s+of|avoid|rather\s+than|out\s+of)\b[^.!?\n]{0,40}\b(brave|chrome|chromium|edge|browser)\b/i

/**
 * Whether the user's own message asks the agent to use their browser. Plain
 * words, on purpose: a mention ("use Brave", "do it in my browser", "open it in
 * Chrome") counts; a refusal anywhere in the message ("don't use Brave",
 * "not in my browser") means the card shows, so the doubt goes to asking.
 */
export function userAskedForTheirBrowser(text: string): boolean {
  if (!ASKS_FOR.test(text)) return false
  return !REFUSES.test(text)
}

// --- What the conversation remembers (in memory, until the app quits) -------

const lastUserText = new Map<string, string>()
const stays = new Map<string, number>()

/** The user sent a message in this chat (agentBus 'user'). */
export function noteUserMessage(chatId: string | undefined, text: string | undefined): void {
  if (!chatId) return
  lastUserText.set(chatId, String(text ?? ''))
}

export function lastUserMessage(chatId: string | null | undefined): string | undefined {
  return chatId ? lastUserText.get(chatId) : undefined
}

/** "Stay here" for this conversation's browser scope. */
export function rememberStay(scope: string, now: number): void {
  stays.set(scope, now + STAY_MS)
}

export function stayUntil(scope: string): number | undefined {
  return stays.get(scope)
}

export function forgetStay(scope: string): void {
  stays.delete(scope)
}

/** For tests. */
export function resetBrowserAsk(): void {
  lastUserText.clear()
  stays.clear()
  asking.clear()
}

const asking = new Map<string, Promise<boolean>>()

/**
 * One card per conversation: a second browser_use while the first waits gets
 * the same answer rather than a second card behind the first.
 */
export function askOnce(scope: string, ask: () => Promise<boolean>): Promise<boolean> {
  const waiting = asking.get(scope)
  if (waiting) return waiting
  const p = ask().finally(() => asking.delete(scope))
  asking.set(scope, p)
  return p
}

// --- Words ------------------------------------------------------------------

const DEFAULT_WHY = 'this site needs your own logins'

/**
 * The agent's reason, as the end of "Claude wants to use your Brave: …". One
 * short line: spaces folded, capped, one full stop.
 */
export function whyLine(why: string | undefined): string {
  const one = String(why ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?…:;,\s]+$/, '')
  const capped = one.length > 120 ? one.slice(0, 119).replace(/\s+\S*$/, '') + '…' : one
  return (capped || DEFAULT_WHY) + (capped.endsWith('…') ? '' : '.')
}

const minutes = (ms: number): number => Math.max(1, Math.round(ms / 60_000))

export function switchedText(name: string): string {
  return (
    `Browser tools now drive ${name}, the user's own browser app, with a ` +
    'Superagent profile separate from their everyday one: they sign in there once, or use ' +
    '"Bring sign-ins over…" in the Browser pill to copy chosen sites\' logins from their ' +
    'everyday browser. It opens on your next browser_navigate. When a page wants a login, ' +
    'captcha or 2FA, call browser_ask_user rather than asking in chat.'
  )
}

/** The user tapped "Stay here", or let the card run out. */
export function stayText(name: string): string {
  return (
    `The user chose to stay in Superagent's built-in browser rather than ${name}. Keep ` +
    'working there. If a page needs them to sign in, call browser_ask_user so they can sign ' +
    `in in the built-in browser. Do not call browser_use('yours') again in this conversation ` +
    `for the next ${minutes(STAY_MS)} minutes unless the user asks for their browser.`
  )
}

/** Asked again while a "Stay here" still holds: no card, the same answer. */
export function stayedText(name: string, leftMs: number): string {
  return (
    `Not asked again: the user chose to stay in Superagent's built-in browser rather than ` +
    `${name} a little while ago. Keep working there, and call browser_ask_user if a page ` +
    'needs them to sign in. You can ask again in about ' +
    `${minutes(leftMs)} minutes, or at once if the user asks for their browser.`
  )
}
