import { EventEmitter } from 'events'

/**
 * Google refuses to sign anyone in on a browser it can tell is being driven
 * ("Couldn't sign you in — This browser or app may not be secure"): phishing
 * kits sit a remote-controlled browser between you and Google. It only looks
 * at sign-in, so the fix is to take the agent's hands off while the user signs
 * in, then give them back — for the built-in pane (browser.ts detaches its
 * debugger) and for the user's real browser (external-browser.ts reopens it
 * without remote control).
 */

/** Google's rejection page. */
export function isGoogleSignInRejected(url: string): boolean {
  try {
    const u = new URL(url)
    return u.hostname === 'accounts.google.com' && /\/signin\/rejected\b/.test(u.pathname)
  } catch {
    return false
  }
}

/** Still inside Google's sign-in (password, 2FA, account chooser). */
export function isGoogleSignIn(url: string): boolean {
  try {
    return new URL(url).hostname === 'accounts.google.com'
  } catch {
    return false
  }
}

/** Where to try again: the sign-in page, going on to wherever it was headed. */
export function signInRetryUrl(rejectedUrl: string): string {
  try {
    const next = new URL(rejectedUrl).searchParams.get('continue')
    if (next && next.startsWith('https://'))
      return `https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(next)}`
  } catch {
    // fall through
  }
  return 'https://accounts.google.com/'
}

/**
 * Built-in panes whose agent is kept off while the user signs in to Google.
 * 'changed' (paneId, on, refused): refused = Google said no even with the agent
 * off, which the built-in browser can't get past.
 */
const handsOff = new Set<string>()
export const signInBus = new EventEmitter()

export function isHandsOff(paneId: string): boolean {
  return handsOff.has(paneId)
}

export function setHandsOff(paneId: string, on: boolean, refused = false): void {
  if (on) handsOff.add(paneId)
  else handsOff.delete(paneId)
  signInBus.emit('changed', paneId, on, refused)
}

export const HANDS_OFF_MESSAGE =
  'The user is signing in to Google in the browser. Google refuses sign-in while an agent ' +
  "drives it, so your browser tools are paused until they're through. Wait for them, then " +
  'carry on.'
