import { app, Menu, BrowserWindow, shell } from 'electron'

/**
 * A proper native macOS menu bar — one of the biggest "feels native" signals.
 * Standard App/File/Edit/View/Window roles plus a few Superagent actions that send
 * to the focused renderer.
 */

/** Zoom the window, then let every native pane re-measure against it. */
function setZoom(dir: 'in' | 'out' | 'reset'): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  const now = wc.getZoomFactor() || 1
  const next =
    dir === 'reset' ? 1 : dir === 'in' ? Math.min(3, now * 1.1) : Math.max(0.3, now / 1.1)
  wc.setZoomFactor(next)
  // A zoom changes every rect in the window at once, and nothing else would
  // tell the panes.
  wc.send('browser:resync')
}

function send(channel: string): void {
  BrowserWindow.getFocusedWindow()?.webContents.send(channel)
}

export function buildMenu(): void {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              {
                label: 'Settings…',
                accelerator: 'CmdOrCtrl+,',
                click: () => send('menu:settings')
              },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const }
            ]
          }
        ]
      : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Project…',
          accelerator: 'CmdOrCtrl+N',
          click: () => send('menu:new-project')
        },
        {
          label: 'New Group',
          accelerator: 'CmdOrCtrl+Shift+N',
          click: () => send('menu:new-group')
        },
        { type: 'separator' },
        // Cmd+W means "close the tab" in every browser, and this is a browser —
        // so it must NOT be the window's `close` role. That role (its default
        // Cmd+W) quietly closed the whole window: on macOS the app then sat
        // windowless in the Dock ("it closed itself, I had to click the icon to
        // get it back"), and on Windows/Linux it quit outright. Route it to the
        // renderer instead, which closes the active browser tab (or does nothing
        // rather than killing the window). The red traffic light / Cmd+Q still
        // close the window and quit.
        {
          label: 'Close Tab',
          accelerator: 'CmdOrCtrl+W',
          click: () => send('menu:close-tab')
        }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Skills', accelerator: 'CmdOrCtrl+K', click: () => send('menu:skills') },
        { label: 'Routines', click: () => send('menu:routines') },
        {
          // Cmd+R means "reload the page" in every browser; it must not be
          // spent on opening a panel.
          label: 'Reload Page',
          accelerator: 'CmdOrCtrl+R',
          click: () => send('menu:reload-page')
        },
        {
          label: 'Reload Page Ignoring Cache',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => send('menu:reload-page-hard')
        },
        {
          label: 'Toggle Preview',
          accelerator: 'CmdOrCtrl+B',
          click: () => send('menu:toggle-preview')
        },
        { type: 'separator' },
        // Not the built-in roles: those zoom the window without telling anything
        // else, and a native pane is placed in window pixels while the renderer
        // measures in CSS pixels — the two agree only at 100%.
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => setZoom('reset') },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+Plus', click: () => setZoom('in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => setZoom('out') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac ? [{ role: 'front' as const }] : [])
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'Superagent on GitHub',
          click: () => shell.openExternal('https://github.com/pungme/superagent-desktop')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
