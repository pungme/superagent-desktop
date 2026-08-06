import { autoUpdater } from 'electron-updater'
import { BrowserWindow, Notification, app, ipcMain } from 'electron'
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
// Whether a downloaded update is waiting to install. The window-all-closed
// handler quits (and thus installs) when this is set — on macOS, closing the
// last window otherwise leaves the OLD version running headless, and the user
// meets the same "restart to update" pill forever.
let updateDownloaded = false
export function isUpdateDownloaded(): boolean {
  return updateDownloaded
}

export function startAutoUpdate(): void {
  // Manual "check now" from Settings. Registered before the dev bail-out so the
  // invoke never dangles in dev — it just reports the current version. If a
  // newer release exists, autoDownload takes over and the usual restart banner
  // appears when it's ready.
  ipcMain.handle('update:check', async () => {
    if (is.dev) return { current: app.getVersion(), latest: null }
    try {
      const r = await autoUpdater.checkForUpdates()
      return { current: app.getVersion(), latest: r?.updateInfo?.version ?? null }
    } catch (err) {
      return {
        current: app.getVersion(),
        latest: null,
        error: String((err as Error)?.message ?? err)
      }
    }
  })

  if (is.dev) return

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = null

  // Progress for the UI: version first (percent 0), then percent as it moves.
  // Without this the stretch between "downloading" and the restart pill is a
  // silent minute-plus for a ~220MB DMG.
  let pendingVersion: string | null = null
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload)
    }
  }
  autoUpdater.on('update-available', (info) => {
    pendingVersion = info.version
    broadcast('update:progress', { version: info.version, percent: 0 })
  })
  autoUpdater.on('download-progress', (p) => {
    broadcast('update:progress', { version: pendingVersion, percent: p.percent })
  })

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true
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
    console.error('[updater]', err?.message ??  err)
    // A silent failure looks like "downloading forever" — the restart pill never
    // arrives and nothing says why. Tell the UI so Settings can show the failure
    // and re-enable the check button as the retry.
    broadcast('update:error', String(err?.message ?? err).slice(0, 200))
  })

  // Renderer can trigger the install immediately (quit + relaunch into the update).
  ipcMain.on('update:install', () => {
    // quitAndInstall on macOS silently no-ops if anything interferes with the
    // quit sequence (observed in the wild: the pill's click did nothing). The
    // canonical robust shape: defer out of the IPC dispatch, force non-silent
    // install + relaunch, and if it throws, say so instead of doing nothing.
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(false, true)
      } catch (err) {
        console.error('[updater] quitAndInstall failed:', err)
        broadcast('update:error', `Restart failed: ${String((err as Error)?.message ?? err)}`)
      }
    })
  })

  // A small delay so it doesn't compete with app startup work.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message ?? err))
  }, 4000)
}
