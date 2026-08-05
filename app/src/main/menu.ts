import { app, Menu, BrowserWindow, shell } from 'electron'

/**
 * A proper native macOS menu bar — one of the biggest "feels native" signals.
 * Standard App/File/Edit/View/Window roles plus a few SuperAgent actions that send
 * to the focused renderer.
 */

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
        isMac ? { role: 'close' } : { role: 'quit' }
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
          label: 'Toggle Preview',
          accelerator: 'CmdOrCtrl+B',
          click: () => send('menu:toggle-preview')
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
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
          label: 'SuperAgent on GitHub',
          click: () => shell.openExternal('https://github.com/pungme/superagent-desktop')
        }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
