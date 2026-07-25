import { app, shell, BrowserWindow, nativeTheme, ipcMain, dialog } from 'electron'
import { basename } from 'path'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { writeFileSync } from 'fs'
import { registerPtyIpc, killAllPtys } from './pty'
import { registerBrowserIpc } from './browser'
import { startMcpServer } from './mcp'
import { registerStoreIpc } from './store'
import { startHookServer, registerHookIpc } from './hooks'
import { registerAutomationIpc } from './automation'
import { registerAgentIpc, killAllAgents } from './agent'
import { registerSkillsIpc } from './skills'
import { startRoutines, stopRoutines, registerRoutinesIpc } from './routines'

if (is.dev) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
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
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
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

  // v0 ships dark-only; light theme is an M5 task. Forcing dark keeps the
  // sidebar vibrancy legible regardless of the system setting.
  nativeTheme.themeSource = 'dark'

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  registerPtyIpc()
  registerBrowserIpc()
  registerStoreIpc()
  registerHookIpc()
  registerAutomationIpc()
  registerAgentIpc()
  registerSkillsIpc()
  registerRoutinesIpc()
  startHookServer()
  startRoutines()

  ipcMain.handle('dialog:pickFolder', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const path = result.filePaths[0]
    return { path, name: basename(path) }
  })

  startMcpServer().then(({ url }) => {
    // Config file for `claude --mcp-config` (Cove-launched sessions pass this).
    const configPath = join(app.getPath('userData'), 'claude-mcp-config.json')
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { 'cove-browser': { type: 'http', url } } }, null, 2)
    )
    console.log(`[mcp] claude config written to ${configPath}`)
  })

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  killAllPtys()
  killAllAgents()
  stopRoutines()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
