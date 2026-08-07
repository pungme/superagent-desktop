import { autoUpdater } from 'electron-updater'
import { BrowserWindow, Notification, app, ipcMain } from 'electron'
import { is } from '@electron-toolkit/utils'
import { appendFileSync } from 'fs'
import { join } from 'path'

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
  // Silence was the problem: "Restart to update" doing nothing left no trace at
  // all, so the same report came back release after release with nothing to go
  // on. Log to userData/updater.log — small, local, and the first thing to read
  // next time an install doesn't take.
  const logFile = join(app.getPath('userData'), 'updater.log')
  const logLine = (level: string, ...args: unknown[]): void => {
    try {
      appendFileSync(
        logFile,
        `${new Date().toISOString()} [${level}] ${args
          .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')}\n`
      )
    } catch {
      /* logging must never break the updater */
    }
  }
  autoUpdater.logger = {
    info: (...a: unknown[]) => logLine('info', ...a),
    warn: (...a: unknown[]) => logLine('warn', ...a),
    error: (...a: unknown[]) => logLine('error', ...a),
    debug: (...a: unknown[]) => logLine('debug', ...a)
  }
  logLine('info', 'updater started', {
    version: app.getVersion(),
    appPath: app.getAppPath(),
    packaged: app.isPackaged
  })

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
    logLine('info', `install requested (downloaded=${updateDownloaded})`)
    setImmediate(() => {
      try {
        // Squirrel's ShipIt installs only once THIS process is gone, and it
        // gives up if the app is still running when it goes to swap the bundle
        // (SQRLInstallerErrorDomain -9, "App Still Running Error" — exactly what
        // the user's log showed). quitAndInstall goes through NSApp terminate,
        // which anything can veto: a window refusing to close, or a page in a
        // browser pane with a beforeunload handler. When that happens nothing
        // visible occurs at all, and ShipIt sits waiting for a process that
        // never dies — the "Restart to update does nothing" report.
        //
        // So: destroy the windows (destroy() cannot be vetoed), ask Squirrel to
        // install, and if we are somehow still alive a moment later, exit hard.
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.destroy()
        }
        autoUpdater.quitAndInstall(false, true)
        setTimeout(() => {
          // Only when Squirrel really has an update staged this session —
          // otherwise a forced exit would just close the app for nothing.
          if (!updateDownloaded) {
            logLine('warn', 'no staged update; not forcing exit')
            return
          }
          logLine('warn', 'still running after quitAndInstall — forcing exit so ShipIt can install')
          // app.exit skips the quit handlers, so run the same cleanup they do
          // (killing agent processes, stopping routines) before going.
          app.emit('before-quit')
          app.exit(0)
        }, 1200)
      } catch (err) {
        logLine('error', `quitAndInstall failed: ${String(err)}`)
        broadcast('update:error', `Restart failed: ${String((err as Error)?.message ?? err)}`)
      }
    })
  })

  // A small delay so it doesn't compete with app startup work.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => console.error('[updater]', err?.message ?? err))
  }, 4000)
}
