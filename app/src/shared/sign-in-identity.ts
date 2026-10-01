/**
 * Google refuses to sign anyone in on a Chromium that is not a known browser:
 * "Couldn't sign you in — This browser or app may not be secure." Its sign-in
 * scripts read `navigator.userAgentData`, find "Chromium" with no "Google
 * Chrome" brand beside it, and stop there. Electron cannot add that brand
 * convincingly — faking it in the headers and in JavaScript was still refused
 * (checked against the real page, October 2026).
 *
 * Firefox has no `navigator.userAgentData`, no `window.chrome`, and sends no
 * `Sec-CH-UA*` headers, so there is no brand list to fail. Presenting Firefox
 * on Google's sign-in hosts — and only there — gets the browser accepted; the
 * same probe then reached the normal "Couldn't find this account" answer for a
 * made-up address. Everywhere else the pane stays the Chrome it is.
 *
 * Shared between main (headers, the UA swap) and the pane's preload (the
 * JavaScript side), so no Electron or Node imports.
 */

/** Google's sign-in pages: accounts.google.com and its country domains, and YouTube's. */
export function isSignInHost(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return (
    /^accounts\.google\.(com|[a-z]{2,3}|com?\.[a-z]{2})$/.test(h) ||
    h === 'accounts.youtube.com' ||
    h === 'gds.google.com'
  )
}

export function isSignInUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && isSignInHost(u.hostname)
  } catch {
    return false
  }
}

/**
 * A current Firefox's version: 143 shipped on 2025-09-16 and one follows every
 * four weeks. Worked out from the date so the identity never goes stale — a
 * Firefox two years out of date earns its own "unsupported browser" page.
 */
export function firefoxVersion(now: number = Date.now()): number {
  const weeks = Math.floor((now - Date.UTC(2025, 8, 16)) / (7 * 24 * 3600_000))
  return 143 + Math.max(0, Math.floor(weeks / 4))
}

export function firefoxUserAgent(now: number = Date.now()): string {
  const v = firefoxVersion(now)
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`
}
