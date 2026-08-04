import { autoUpdater } from 'electron-updater'
import { BrowserWindow, Notification, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'

/**
 * Background auto-update against the GitHub Releases feed (configured via the
 * `publish` block in electron-builder.yml → app-update.yml). Downloads a newer
 * release quietly and installs it on the next quit; the renderer is told when an
 * update is ready so it can offer a "Restart to update" affordance.
 *
 * Only runs in a packaged build. On macOS the running app must be signed with a
 * Developer ID for the update to actually apply (an unsigned/dev-cert build will
 * download but fail to swap itself in) — see the notarization notes.
 */
export function startAutoUpdate(): void {
  if (is.dev) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  autoUpdater.on('update-downloaded', (info) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('update:ready', info.version)
    }
    if (Notification.isSupported()) {
      new Notification({
        title: 'SuperAgent update ready',
        body: `Version ${info.version} will install the next time you quit — or restart now.`
      }).show()
    }
  })

  autoUpdater.on('error', (err) => {
    console.error('[updater]', err?.message ?? err)
  })

  // Renderer can trigger the install immediately (quit + relaunch into the update).
  ipcMain.on('update:install', () => autoUpdater.quitAndInstall())

  // A small delay so it doesn't compete with app startup work.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message ?? err))
  }, 4000)
}
