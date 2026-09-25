import { app, BrowserWindow, Notification } from 'electron'

/**
 * Tests that must not disturb whoever is using the Mac (COVE_E2E_QUIET=1): the
 * app runs with no window on screen, no Dock icon, no menu-bar icon, no
 * notifications, and never takes focus. Playwright drives the page over CDP,
 * which works the same on a hidden window. External browsers (Brave) run
 * headless too — see external-browser.ts.
 *
 * Done here, once, rather than at each of the dozen places that show or focus
 * something: a test run that pops one window has already failed at its job.
 */
export const QUIET = process.env.COVE_E2E_QUIET === '1'

if (QUIET) {
  const noop = function (): void {}
  BrowserWindow.prototype.show = noop
  BrowserWindow.prototype.showInactive = noop
  BrowserWindow.prototype.focus = noop
  BrowserWindow.prototype.moveTop = noop
  BrowserWindow.prototype.maximize = noop
  Notification.prototype.show = noop
  app.focus = noop as typeof app.focus
  void app.whenReady().then(() => app.dock?.hide())
}
