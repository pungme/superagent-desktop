import { contextBridge } from 'electron'
import { firefoxUserAgent, isSignInHost } from '../shared/sign-in-identity'

/**
 * The browser pane's preload: on Google's sign-in pages, the page sees a
 * Firefox — see shared/sign-in-identity.ts for why. Runs in the page's own
 * world before any of its scripts, and does nothing on any other site.
 */
if (isSignInHost(location.hostname)) {
  const ua = firefoxUserAgent()
  contextBridge.executeInMainWorld({
    func: (userAgent: string) => {
      const def = (target: object, key: string, value: unknown): void => {
        try {
          Object.defineProperty(target, key, { get: () => value, configurable: true })
        } catch {
          // a property the engine will not let go of: leave it
        }
      }
      const nav = Navigator.prototype
      // Firefox has neither of these; their presence is what gives Chromium away.
      def(nav, 'userAgentData', undefined)
      def(window, 'chrome', undefined)
      def(nav, 'userAgent', userAgent)
      def(nav, 'appVersion', '5.0 (Macintosh)')
      def(nav, 'vendor', '')
      def(nav, 'productSub', '20100101')
      def(nav, 'oscpu', 'Intel Mac OS X 10.15')
      def(nav, 'webdriver', false)
    },
    args: [ua]
  })
}
