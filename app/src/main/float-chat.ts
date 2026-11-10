import { BrowserWindow, ipcMain, WebContentsView } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import { keepOnTop } from './overlay-stack'
import {
  floatBounds,
  type FloatAction,
  type FloatCommand,
  type FloatPlace,
  type FloatSize,
  type FloatState
} from '../shared/float-chat'

/**
 * Browser first: the page takes the whole desk and the chat floats over it, in
 * the bottom-right corner (ChatDesk decides when; FloatChat.tsx draws it).
 *
 * The page is a native view, painted above every bit of the window's HTML, so
 * nothing drawn by the app's own page can sit over it. The floating chat is a
 * view of its own instead: transparent, kept above the page views
 * (overlay-stack.ts), and only as big as what it shows right now, because a
 * view takes every click inside its rectangle, see-through or not.
 *
 * The conversation itself stays in the app's page (the chat's <EasyChat>, where
 * its agent lives). That page sends what to show here (float:state) and where
 * (float:place); this view sends back what was asked (float:action), which main
 * hands to the app's page. Nothing of the agent runs in this view.
 */

interface Float {
  view: WebContentsView
  place: FloatPlace | null
  size: FloatSize
  state: FloatState | null
  ready: boolean
}

const floats = new Map<number, Float>()

function senderWindow(
  e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent
): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

/** The window a float view belongs to, from the view's own web contents. */
function windowOfFloat(wc: Electron.WebContents): BrowserWindow | null {
  for (const [id, f] of floats) if (f.view.webContents === wc) return BrowserWindow.fromId(id)
  return null
}

function ensure(win: BrowserWindow): Float {
  const have = floats.get(win.id)
  if (have) return have
  const view = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  view.setBackgroundColor('#00000000')
  view.setVisible(false)
  const f: Float = { view, place: null, size: { w: 80, h: 96 }, state: null, ready: false }
  floats.set(win.id, f)
  win.contentView.addChildView(view)
  keepOnTop(win, view)
  // It shows our own page and nothing else: no popups, no navigating away.
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  view.webContents.on('will-navigate', (e) => e.preventDefault())
  view.webContents.on('did-finish-load', () => {
    f.ready = true
    if (f.state) view.webContents.send('float:state', f.state)
  })
  if (is.dev && process.env['ELECTRON_RENDERER_URL'])
    void view.webContents.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#float`)
  else void view.webContents.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'float' })
  win.on('closed', () => {
    floats.delete(win.id)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  })
  return f
}

/** Put the view where the chat should be, at the size it asked for, or take it away. */
function layout(win: BrowserWindow, f: Float): void {
  if (win.isDestroyed()) return
  if (!f.place) {
    f.view.setVisible(false)
    return
  }
  // The page measures in CSS pixels; the window is laid out at its zoom.
  const z = win.webContents.getZoomFactor()
  const r = f.place.rect
  const b = floatBounds({ x: r.x * z, y: r.y * z, w: r.w * z, h: r.h * z }, f.size)
  f.view.setBounds(b)
  f.view.setVisible(true)
  keepOnTop(win, f.view)
}

/** The float view of a window, for tests and for menu commands. */
export function floatViewOf(win: BrowserWindow): WebContentsView | null {
  return floats.get(win.id)?.view ?? null
}

/** A menu command (⌘\, ⌘⇧\) for the window's floating chat, if it has one on screen. */
export function sendFloatCommand(win: BrowserWindow, cmd: FloatCommand): boolean {
  const f = floats.get(win.id)
  if (!f?.place || win.isDestroyed()) return false
  f.view.webContents.send('float:command', cmd)
  if (cmd !== 'close') f.view.webContents.focus()
  return true
}

export function registerFloatChatIpc(): void {
  // From the app's page: where the chat floats (the page's rectangle), or null.
  ipcMain.on('float:place', (e, place: FloatPlace | null) => {
    const win = senderWindow(e)
    if (!win) return
    if (!place) {
      const f = floats.get(win.id)
      if (f) {
        f.place = null
        layout(win, f)
      }
      return
    }
    const f = ensure(win)
    f.place = place
    layout(win, f)
  })
  // From the app's page: what to show (the last messages, whether it is working).
  ipcMain.on('float:state', (e, state: FloatState) => {
    const win = senderWindow(e)
    if (!win) return
    const f = ensure(win)
    f.state = state
    if (f.ready) f.view.webContents.send('float:state', state)
  })
  // From the float view: how much room it needs now.
  ipcMain.on('float:size', (e, size: FloatSize) => {
    const win = windowOfFloat(e.sender)
    if (!win) return
    const f = floats.get(win.id)!
    f.size = { w: Math.max(40, Math.min(2000, size.w)), h: Math.max(40, Math.min(2000, size.h)) }
    layout(win, f)
  })
  // From the float view: something to do in the app's page (send, side by side…).
  ipcMain.on('float:action', (e, action: FloatAction) => {
    const win = windowOfFloat(e.sender)
    if (!win || win.isDestroyed()) return
    win.webContents.send('float:action', action)
    if (action.type === 'side' || action.type === 'focus-app') win.webContents.focus()
  })
}
