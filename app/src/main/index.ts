import {
  app,
  shell,
  BrowserWindow,
  Menu,
  clipboard,
  nativeTheme,
  ipcMain,
  dialog,
  session, nativeImage } from 'electron'
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
  attachPanesOnReturn,
  watchWindowGeometry
} from './browser'
import { startMcpServer } from './mcp'
import { registerStoreIpc } from './store'
import { mergeLegacyPartitions } from './session-merge'
import { registerDesktopIpc } from './desktop'
import { registerDeskIpc } from './desk'
import { startHookServer, registerHookIpc } from './hooks'
import { registerAutomationIpc } from './automation'
import { registerAgentIpc, killAllAgents } from './agent'
import { startCompanionLog, forgetChat } from './companion/log'
import { startCompanion, stopCompanion, registerCompanionIpc, companionBus } from './companion'
import { startTray, refreshTray } from './tray'
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
// IDENTIFIER — never change this string. Electron derives the user-data folder
// (~/Library/Application Support/<name>) and the keychain item that encrypts
// cookies and companion secrets (<name> Safe Storage) from it. 1.7.2 changed it
// to the new spelling and every updated install came up empty: data and
// logins were still on disk, under the old name, unreachable. The visible
// brand is "Superagent"; this is not the visible brand.
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
  //
  // Releasing the focus guard (which restores the Dock icon and Mission
  // Control presence — the ONLY thing that stops a background page load from
  // raising the window, per the note by setPolicy) used to happen the instant
  // this event fired. During active browser automation, real focus flickers
  // constantly between this window and whatever else is open (a terminal, the
  // Simulator) — each flicker released the guard, and the very next automation
  // call re-engaged it, which is what a real capture showed as 70+ Dock
  // in/out cycles in two minutes: not a runaway timer, genuine fast alt-
  // tabbing hitting a guard that reacted to every single glance. The fix is
  // not to remove the guard (that brings back the window actually jumping to
  // the front, which is the bug this exists for) — it's to only release once
  // focus has actually held for a moment, so a flicker that reverses itself
  // within a couple of frames never touches the Dock at all.
  let focusSettleTimer: ReturnType<typeof setTimeout> | null = null
  mainWindow.on('focus', () => {
    paneLog('window-focus', 'window')
    mainWindow.webContents.send('app:focus', true)
    // If this focus arrived during agent work, the user didn't ask for it —
    // this is separately guarded to fire at most once per guard cycle, so it's
    // safe to run on every focus event rather than only the settled one.
    returnFocusToUser()
    if (focusSettleTimer) clearTimeout(focusSettleTimer)
    focusSettleTimer = setTimeout(() => {
      focusSettleTimer = null
      // Blurred again before settling: a flicker, not a real return. Leave the
      // guard exactly as it was — nothing to undo, since releaseFocusGuard()
      // never ran for it.
      if (!mainWindow.isFocused()) return
      // The user is here, and has been for a beat — the app is frontmost, so
      // attaching the panes we kept out of the window can no longer steal
      // anything.
      releaseFocusGuard()
      attachPanesOnReturn()
    }, 250)
  })
  mainWindow.on('blur', () => {
    noteUserLeftApp()
    // The renderer can't tell: document.hasFocus() stays true in an unfocused
    // app window, so the pane's freeze-while-away has to be driven from here.
    mainWindow.webContents.send('app:focus', false)
    if (focusSettleTimer) {
      clearTimeout(focusSettleTimer)
      focusSettleTimer = null
    }
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

  // Resized, moved, fullscreened, zoomed, or dragged to another display: every
  // one of those moves a native pane's slot without the renderer noticing.
  watchWindowGeometry(mainWindow)

  return mainWindow
}

app.whenReady().then(async () => {
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

  // Copy through Electron's own clipboard, not navigator.clipboard: the Web API
  // rejects (silently) whenever the document isn't focused — which it often
  // isn't here, since the native browser/simulator pane holds focus. This one
  // always lands.
  ipcMain.on('clipboard:write', (_e, text: string) => clipboard.writeText(text))

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerBrowserIpc()
  registerStoreIpc()
  registerDesktopIpc()
  registerDeskIpc()
  registerHookIpc()
  registerAutomationIpc()
  registerAgentIpc()
  // Must attach before any session starts: it is what the phone reads from.
  startCompanionLog()
  registerSkillsIpc()
  registerRoutinesIpc()
  registerEnvironmentIpc()
  registerFilesIpc()
  registerSimulatorIpc()
  buildMenu()
  startHookServer()
  startRoutines()
  // The phone companion: an outbound relay connection that stays up.
  registerCompanionIpc()
  startCompanion()
  // Menu-bar presence while a phone is paired; follows pairing/relay changes.
  startTray()
  companionBus.on('state', refreshTray)

  // Which Superagent this is. Worth surfacing now that builds auto-update in the
  // background — otherwise there's no way to tell what you're running, or to say
  // so in a bug report.
  ipcMain.handle('app:version', () => app.getVersion())

  // Right-click a chat row: clear (wipe transcript + session, keep the row) or delete.
  // Keep / Throw away, shared by the context menu and the in-chat buttons. The
  // words branch/worktree/merge never appear — the user keeps a chat's changes
  // or throws them away.
  const askKeep = async (
    win: BrowserWindow,
    p: { chatId: string; workspaceId: string; projectPath: string; wtPath: string }
  ): Promise<void> => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Keep', 'Cancel'],
      defaultId: 0,
      message: "Keep this chat's changes?",
      detail: "They'll be added to the project as one change. The chat closes."
    })
    if (response === 0) win.webContents.send('chat:merge-worktree', p)
  }
  const askThrowAway = async (
    win: BrowserWindow,
    p: { chatId: string; workspaceId: string }
  ): Promise<void> => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Throw away', 'Cancel'],
      defaultId: 1,
      message: "Throw away this chat's changes?",
      detail: "Everything it did is deleted. This can't be undone."
    })
    if (response === 0) win.webContents.send('chat:throw-away', p)
  }
  ipcMain.on(
    'chat:keep-request',
    (e, p: { chatId: string; workspaceId: string; projectPath: string; wtPath: string }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (win) void askKeep(win, p)
    }
  )
  ipcMain.on('chat:throw-request', (e, p: { chatId: string; workspaceId: string }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) void askThrowAway(win, p)
  })
  // Deleting a chat that still has unkept changes: the renderer asks here for
  // the three-way native dialog before anything happens.
  ipcMain.handle('chat:confirm-unkept', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return 'cancel'
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Keep', 'Throw away', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: "This chat has changes you haven't kept.",
      detail: 'Keep adds them to the project as one change. Throw away deletes them.'
    })
    return response === 0 ? 'keep' : response === 1 ? 'throw' : 'cancel'
  })

  /**
   * Replace the Dock icon of the running app.
   *
   * The renderer draws it (see app-icon.ts) and hands over PNG bytes; null puts
   * the real one back. Only the Dock changes — Finder and Spotlight read the
   * icon out of the signed bundle, and rewriting that would break the
   * signature, so a custom icon is a thing you see while the app runs.
   */
  ipcMain.handle('app:set-icon', (_e, png: Uint8Array | null) => {
    if (!app.dock) return false
    if (!png || png.length === 0) {
      app.dock.setIcon(nativeImage.createFromPath(join(process.resourcesPath, 'icon.png')))
      return true
    }
    const img = nativeImage.createFromBuffer(Buffer.from(png))
    if (img.isEmpty()) return false
    app.dock.setIcon(img)
    return true
  })

  ipcMain.on('chat:menu', (e, chatId: string, workspaceId: string, cwd?: string | null) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    const template: Electron.MenuItemConstructorOptions[] = []
    // A worktree chat's changes can be kept (squashed into the project) or
    // thrown away when you're done.
    if (cwd && cwd.includes('/.worktrees/')) {
      const projectPath = cwd.split('/.worktrees/')[0]
      template.push(
        {
          label: 'Keep changes…',
          click: () => void askKeep(win, { chatId, workspaceId, projectPath, wtPath: cwd })
        },
        {
          label: 'Throw away…',
          click: () => void askThrowAway(win, { chatId, workspaceId })
        },
        { type: 'separator' }
      )
    }
    template.push(
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
          if (response === 0) {
            forgetChat(chatId)
            win.webContents.send('chat:cleared', { chatId, workspaceId })
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Delete chat',
        click: () => win.webContents.send('chat:delete', { chatId, workspaceId })
      }
    )
    Menu.buildFromTemplate(template).popup({ window: win })
  })

  // Right-click a branch row. These actions have to live here rather than only
  // inside a chat: a worktree whose chat was deleted still exists on disk, and
  // used to be both invisible and unreachable — you could see the work but had
  // no way to land it or bin it.
  ipcMain.on(
    'worktree:menu',
    (
      e,
      p: { projectPath: string; wtPath: string; branch: string | null; base: string | null }
    ) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return
      const send = (action: 'merge' | 'delete'): void =>
        win.webContents.send('worktree:menu-action', { action, ...p })
      const template: Electron.MenuItemConstructorOptions[] = [
        {
          label: p.base ? `Merge into ${p.base}…` : 'Merge…',
          click: () => send('merge')
        },
        { label: 'Delete branch…', click: () => send('delete') },
        { type: 'separator' },
        { label: 'Reveal in Finder', click: () => shell.showItemInFolder(p.wtPath) },
        { label: 'Copy Path', click: () => clipboard.writeText(p.wtPath) }
      ]
      Menu.buildFromTemplate(template).popup({ window: win })
    }
  )

  // Right-click a project row in the sidebar. Worktree chats are the point —
  // a sibling conversation on a fresh git worktree of the project, so two lines
  // of work don't step on each other's files. Only offered for a real repo.
  ipcMain.on(
    'workspace:menu',
    (e, ws: { id: string; path: string; isRepo: boolean; chatId?: string | null }) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    const send = (action: string): void =>
      win.webContents.send('workspace:menu-action', { action, id: ws.id, path: ws.path })
    // One entry: New Chat isolates itself on a repo now (a chat is a checkout),
    // so the separate worktree item is gone.
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: 'New Chat', click: () => send('new-chat') }
    ]
    // This row IS the conversation that works in the folder — it has no row of
    // its own — so the only place to empty it is here.
    if (ws.chatId) {
      const chatId = ws.chatId
      template.push({
        label: 'Clear this conversation…',
        click: async () => {
          const { response } = await dialog.showMessageBox(win, {
            type: 'warning',
            buttons: ['Clear', 'Cancel'],
            defaultId: 1,
            message: 'Clear this conversation?',
            detail:
              'Everything said in it goes, on this Mac and on your phone, and the agent starts fresh. The project and its files are untouched.'
          })
          if (response === 0) {
            forgetChat(chatId)
            win.webContents.send('chat:cleared', { chatId, workspaceId: ws.id })
          }
        }
      })
    }
    template.push(
      { type: 'separator' },
      { label: 'Reveal in Finder', click: () => shell.showItemInFolder(ws.path) },
      { label: 'Copy Path', click: () => clipboard.writeText(ws.path) }
    )
    Menu.buildFromTemplate(template).popup({ window: win })
    }
  )

  // Right-click a desktop icon (or a multi-selection). The renderer owns the
  // actual actions (it has the desk state), so this native menu just routes the
  // chosen verb back with the paths it applies to.
  ipcMain.on(
    'desk:menu',
    (e, info: { paths: string[]; single: boolean; isLink: boolean; isDir: boolean }) => {
      const win = BrowserWindow.fromWebContents(e.sender)
      if (!win) return
      const send = (action: string): void =>
        win.webContents.send('desk:menu-action', { action, paths: info.paths })
      const template: Electron.MenuItemConstructorOptions[] = []
      if (info.single) {
        template.push(
          { label: 'Open', click: () => send('open') },
          { label: 'Rename', click: () => send('rename') }
        )
      }
      // A link just comes off the desk; a real file goes to the Trash.
      const del = info.isLink
        ? 'Remove from Desktop'
        : info.paths.length > 1
          ? `Move ${info.paths.length} Items to Trash`
          : 'Move to Trash'
      template.push(
        { label: 'Reveal in Finder', click: () => send('reveal') },
        { type: 'separator' },
        { label: del, click: () => send('delete') }
      )
      Menu.buildFromTemplate(template).popup({ window: win })
    }
  )

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

  // Before any pane exists: the old per-project cookie jars fold into the one
  // shared session, so an update doesn't read as "it logged me out". One-time,
  // and a no-op on every launch after the first.
  await mergeLegacyPartitions()

  createWindow()

  // Check GitHub Releases for a newer version and update quietly (packaged only).
  startAutoUpdate()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  stopCompanion()
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
