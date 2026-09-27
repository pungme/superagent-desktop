import { EventEmitter } from 'events'
import Database from 'better-sqlite3'
import { copyFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

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

/** The cookies that mean "signed in to Google". */
const SESSION_COOKIES = ['SID', '__Secure-1PSID', '__Secure-3PSID']

/**
 * When a browser profile last got a Google session cookie (Chromium's clock,
 * microseconds since 1601), or 0n if it has none. This is how Superagent tells
 * that the user finished signing in while it has no remote control to look
 * with: the browser saves its cookies to the profile within ~30 seconds.
 * Read through a copy, as the running browser holds the file.
 */
export function sessionCookieTime(profile: string, host = 'google.com'): bigint {
  const tmp = mkdtempSync(join(tmpdir(), 'sa-signin-'))
  try {
    copyFileSync(join(profile, 'Cookies'), join(tmp, 'Cookies'))
    const db = new Database(join(tmp, 'Cookies'), { readonly: true })
    try {
      const row = db
        .prepare(
          `SELECT MAX(creation_utc) AS at FROM cookies
           WHERE name IN (${SESSION_COOKIES.map(() => '?').join(', ')})
             AND (host_key = ? OR host_key = ? OR host_key LIKE ?)`
        )
        .safeIntegers(true)
        .get(...SESSION_COOKIES, host, '.' + host, '%.' + host) as { at: bigint | null }
      return row.at ?? 0n
    } finally {
      db.close()
    }
  } catch {
    // No cookie file yet, or mid-write: nothing to report this time.
    return 0n
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
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
  'The user is signing in to Google in the browser and has not finished. Google refuses sign-in ' +
  'while an agent drives it, so your browser tools are paused until they are through. Ask them ' +
  'to finish signing in, then wait for their reply before trying again.'
