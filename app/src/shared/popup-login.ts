/**
 * Sign-in in a popup ("Continue with Google" opening a small window that hands the
 * login back to the page that opened it with postMessage / window.opener). A popup has
 * to stay a window with a link to its opener: loaded into the pane instead, the page
 * loses its opener and the login never arrives. Everything else a page opens
 * (target=_blank, links) still loads in the pane: one browser per project.
 */

export interface OpenRequest {
  url: string
  /** Electron's disposition: 'new-window' is window.open(url, name, 'width=…'). */
  disposition: string
  /** The features string, "width=500,height=600". */
  features?: string
}

/** Hosts whose pages are a sign-in step: popped up even by a plain window.open. */
const SIGN_IN_HOSTS = new Set([
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'www.facebook.com',
  'm.facebook.com',
  'github.com',
  'gitlab.com',
  'discord.com',
  'api.twitter.com',
  'x.com',
  'twitter.com'
])
const SIGN_IN_PATH =
  /\/(o\/oauth2|oauth|oauth2|signin|sign-in|login|authorize|authenticate|dialog\/oauth|auth)\b/i

export function popupDecision(r: OpenRequest): 'popup' | 'pane' | 'deny' {
  if (r.disposition === 'background-tab') return 'pane'
  // about:blank first, navigated later: Firebase and Auth0 open it before they know where.
  if (r.url === '' || r.url === 'about:blank')
    return r.disposition === 'new-window' ? 'popup' : 'deny'
  let u: URL
  try {
    u = new URL(r.url)
  } catch {
    return 'deny'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'deny'
  if (r.disposition === 'new-window') return 'popup'
  if (SIGN_IN_HOSTS.has(u.hostname) && SIGN_IN_PATH.test(u.pathname)) return 'popup'
  return 'pane'
}

/** The size the page asked for, kept to something sensible; a usual sign-in size otherwise. */
export function popupSize(features?: string): { width: number; height: number } {
  const get = (k: string): number => {
    const m = new RegExp(`(?:^|[,\\s])${k}\\s*=\\s*(\\d+)`, 'i').exec(features ?? '')
    return m ? Number(m[1]) : 0
  }
  const clamp = (n: number, lo: number, hi: number, d: number): number =>
    n ? Math.min(hi, Math.max(lo, n)) : d
  return { width: clamp(get('width'), 320, 900, 500), height: clamp(get('height'), 400, 900, 640) }
}
