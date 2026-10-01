import { join } from 'path'
import type { Session, WebContents } from 'electron'
import { firefoxUserAgent, isSignInUrl } from '../shared/sign-in-identity'

/**
 * Main's half of the Firefox identity on Google's sign-in pages (see
 * shared/sign-in-identity.ts): the request headers, and the user agent the
 * page is created with. The JavaScript side is the pane's preload.
 */

const sessionsDone = new WeakSet<Session>()

function hardenSession(ses: Session): void {
  if (sessionsDone.has(ses)) return
  sessionsDone.add(ses)
  // Requests TO a sign-in host: Firefox's User-Agent, and none of the client
  // hints only a Chromium sends. Everything else goes out untouched.
  ses.webRequest.onBeforeSendHeaders((details, done) => {
    if (!isSignInUrl(details.url)) return done({})
    const headers = details.requestHeaders
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (lower.startsWith('sec-ch-')) delete headers[name]
      else if (lower === 'user-agent') headers[name] = firefoxUserAgent()
    }
    done({ requestHeaders: headers })
  })
  ses.registerPreloadScript({
    type: 'frame',
    filePath: join(__dirname, '../preload/pane.js')
  })
}

/**
 * Give a pane the Firefox identity while its main frame is on a sign-in host,
 * and its own (`chromeUA`) the rest of the time.
 *
 * The user agent is switched at two moments only, and never during a redirect:
 * changing it mid-redirect restarts the navigation, and a site that merely
 * passes through accounts.google.com (signed-out Calendar does, on its way to
 * a marketing page) looped for ever — 400 redirects in the test that found it.
 *  - a navigation that STARTS on a sign-in page (or leaves one): before the
 *    request goes out;
 *  - one that ARRIVES there through redirects: once the page has landed, and
 *    it is reloaded once so it is created under the right identity.
 * The header rewrite alone is not enough: with the page's own requests still
 * going out as Chrome, Google refuses (checked against the real page).
 */
export function applySignInIdentity(wc: WebContents, chromeUA: string): void {
  hardenSession(wc.session)
  const want = (url: string): string => (isSignInUrl(url) ? firefoxUserAgent() : chromeUA)
  wc.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return
    if (wc.getUserAgent() !== want(details.url)) wc.setUserAgent(want(details.url))
  })
  // Reloads in a row, so a page that keeps landing on the wrong side cannot
  // spin; reset by any navigation that lands right.
  let corrections = 0
  wc.on('did-navigate', (_e, url) => {
    if (wc.getUserAgent() === want(url)) {
      corrections = 0
      return
    }
    if (corrections >= 2) return
    corrections++
    wc.setUserAgent(want(url))
    wc.reload()
  })
}
