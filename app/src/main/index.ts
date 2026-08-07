import { app, shell, BrowserWindow, Menu, clipboard, nativeTheme, ipcMain, dialog, session } from 'electron'
import { basename } from 'path'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import {
  registerBrowserIpc,
  paneLog,
  releaseFocusGuard,
  returnFocusToUser,
  noteUserLeftApp,
  attachPanesOnReturn
} from './browser'
import { startMcpServer } from './mcp'
import { registerStoreIpc } from './store'
import { startHookServer, registerHookIpc } from './hooks'
import { registerAutomationIpc } from './automation'
import { registerAgentIpc, killAllAgents } from './agent'
import { registerSkillsIpc } from './skills'
import { startRoutines, stopRoutines, registerRoutinesIpc } from './routines'
import { registerEnvironmentIpc } from './environment'
import { registerFilesIpc } from './files'
import { registerSimulatorIpc, stopAllSimStreams, stopAllSimInput } from './simulator'
import { buildMenu } from './menu'
import { startAutoUpdate, isUpdateDownloaded } from './updater'

// Must run before `ready`: it names the About panel, the menu's first submenu and
// the userData directory. Packaged builds also get this from electron-builder's
// productName, but dev runs would otherwise fall back to the package.json name.
app.setName('SuperAgent')

// Opt-in only: an open remote-debugging port is a live DevTools-protocol endpoint
// that bot-detection (Cloudflare et al.) flags as automation and challenges on, so
// normal dev browsing must not expose it. Set COVE_REMOTE_DEBUG=1 for CDP/tests.
if (is.dev && process.env.COVE_REMOTE_DEBUG) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// E2E tests point userData at a throwaway dir so they never touch real config.
if (process.env.COVE_USER_DATA) {
  app.setPath('userData', process.env.COVE_USER_DATA)
}

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    transparent: false,
    backgroundColor: '#00000000',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Explicit (not just relying on Electron defaults) so the renderer can never
      // reach Node — only the contextBridge `cove` API. sandbox:false is needed
      // for the Node-using preload; the window only ever loads trusted app content.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // Focus trace. "The app jumped in front of me" has been reported repeatedly
  // and never reproduced on demand — nothing in our code raises the window
  // outside notification clicks. These lines land in pane-debug.log next to the
  // agent's actions, so the next occurrence shows what immediately preceded it.
  mainWindow.on('focus', () => {
    paneLog('window-focus', 'window')
    mainWindow.webContents.send('app:focus', true)
    // If this focus arrived during agent work, the user didn't ask for it.
    returnFocusToUser()
    // The user is here now — the app is frontmost, so attaching the panes we
    // kept out of the window can no longer steal anything.
    releaseFocusGuard()
    attachPanesOnReturn()
  })
  mainWindow.on('blur', () => {
    noteUserLeftApp()
    // The renderer can't tell: document.hasFocus() stays true in an unfocused
    // app window, so the pane's freeze-while-away has to be driven from here.
    mainWindow.webContents.send('app:focus', false)
  })
  mainWindow.on('show', () => paneLog('window-show', 'window'))
  app.on('activate', () => paneLog('app-activate', 'window'))

  mainWindow.on('ready-to-show', () => {
    // Tooling relaunches (screenshot/verification loops) must never steal focus
    // from whatever the user is doing — a maximized window shoving itself
    // forward on every dev restart reads as the app misbehaving.
    if (process.env.COVE_NO_FOCUS) {
      mainWindow.showInactive()
      return
    }
    // Open filling the screen (maximized, keeping the menu bar/traffic lights) so
    // the app isn't a small window on every launch.
    mainWindow.maximize()
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // The app shell must never navigate away (a dragged URL/file or a stray link
  // would otherwise white-screen the app). Allow same-origin (dev HMR reloads,
  // SPA) and send any cross-origin navigation to the system browser instead.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    try {
      if (new URL(url).origin !== new URL(mainWindow.webContents.getURL()).origin) {
        e.preventDefault()
        shell.openExternal(url)
      }
    } catch {
      e.preventDefault()
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('dev.cove.app')

  // Electron denies permission requests by default, which would silently break
  // push-to-talk dictation. Only the microphone is granted, and only to our own
  // renderer — pages in the browser pane get nothing.
  const ownUi = process.env['ELECTRON_RENDERER_URL'] ?? 'file://'
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    const isOwnUi = contents.getURL().startsWith(ownUi)
    callback(isOwnUi && permission === 'media')
  })

  // Theme (drives the sidebar vibrancy). The renderer sends the user's choice;
  // default to following the system until it does.
  nativeTheme.themeSource = 'system'
  ipcMain.on('theme:set', (_e, source: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = source
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerBrowserIpc()
  registerStoreIpc()
  registerHookIpc()
  registerAutomationIpc()
  registerAgentIpc()
  registerSkillsIpc()
  registerRoutinesIpc()
  registerEnvironmentIpc()
  registerFilesIpc()
  registerSimulatorIpc()
  buildMenu()
  startHookServer()
  startRoutines()

  // Which SuperAgent this is. Worth surfacing now that builds auto-update in the
  // background — otherwise there's no way to tell what you're running, or to say
  // so in a bug report.
  ipcMain.handle('app:version', () => app.getVersion())

  // Right-click a chat row: clear (wipe transcript + session, keep the row) or delete.
  ipcMain.on('chat:menu', (e, chatId: string, workspaceId: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    const menu = Menu.buildFromTemplate([
      {
        label: 'Clear chat…',
        click: async () => {
          const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Clear', 'Cancel'],
            defaultId: 1,
            message: 'Clear this chat?',
            detail: 'The transcript and its session context are wiped. The chat itself stays.'
          })
          if (response === 0) win.webContents.send('chat:cleared', { chatId, workspaceId })
        }
      },
      { type: 'separator' },
      {
        label: 'Delete chat',
        click: () => win.webContents.send('chat:delete', { chatId, workspaceId })
      }
    ])
    menu.popup({ window: win })
  })

  // Right-click on a file-tree row: the little things a real file browser owes you.
  ipcMain.on('files:menu', (e, absPath: string) => {
    const menu = Menu.buildFromTemplate([
      { label: 'Reveal in Finder', click: () => shell.showItemInFolder(absPath) },
      { label: 'Copy Path', click: () => clipboard.writeText(absPath) },
      { type: 'separator' },
      { label: 'Open with Default App', click: () => void shell.openPath(absPath) }
    ])
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) menu.popup({ window: win })
  })

  ipcMain.handle('dialog:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    return { path, name: basename(path) }
  })

  // Every launch writes its own per-workspace MCP config (with ?ws=…), so no
  // global config file is needed.
  startMcpServer()

  createWindow()

  // Check GitHub Releases for a newer version and update quietly (packaged only).
  startAutoUpdate()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  killAllAgents()
  stopRoutines()
  stopAllSimStreams()
  stopAllSimInput()
})

app.on('window-all-closed', () => {
  // A pending update installs on quit — and with no windows open there is
  // nothing to lose, so take the moment. Otherwise closing the last window
  // leaves the OLD version running headless (macOS convention), and reopening
  // from the Dock resurrects the same stale process with the same "restart to
  // update" pill: the infinite-update-loop report.
  if (process.platform !== 'darwin' || isUpdateDownloaded()) {
    app.quit()
  }
})
