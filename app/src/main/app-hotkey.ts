import { app, globalShortcut, ipcMain, type BrowserWindow } from 'electron'
import { kvGet, kvSet } from './store'
import { broadcastToWindows } from './util'
import {
  appHotkeyAction,
  appHotkeyFrom,
  NO_APP_HOTKEY,
  type AppHotkeyState
} from '../shared/app-hotkey'

/**
 * A shortcut that works from any app: it brings Superagent's window to the
 * front, and pressed again while it is in front, puts it away and hands the
 * keyboard back to whatever was there before.
 */

const KEY = 'app.hotkey'
let held: string | null = null
let ok = true
let host: { window: () => BrowserWindow | null; create: () => void; wanted: () => void } | null =
  null

export function appHotkey(): AppHotkeyState {
  return { hotkey: appHotkeyFrom(kvGet(KEY)), ok }
}

/** Bring the app's window forward, making one if it was closed. */
export function bringAppForward(): BrowserWindow | null {
  if (!host) return null
  let w = host.window()
  if (!w) {
    host.create()
    w = host.window()
  }
  if (!w) return null
  // Asked for by the user, by name: not a focus to bounce back.
  host.wanted()
  if (w.isMinimized()) w.restore()
  w.show()
  w.focus()
  app.focus({ steal: true })
  return w
}

function pressed(): void {
  const w = host?.window() ?? null
  const action = appHotkeyAction({
    exists: !!w,
    visible: !!w?.isVisible(),
    focused: !!w?.isFocused(),
    minimized: !!w?.isMinimized()
  })
  // Hiding the app, rather than the window, is what gives the keyboard back to
  // the app the user came from.
  if (action === 'hide') app.hide()
  else bringAppForward()
}

/**
 * macOS gives a shortcut to whoever asked first and refuses one another app
 * already has, without a word: `register` just answers false. That is kept, so
 * Settings can say so. A test run never takes a key from the person at the Mac.
 */
function register(): void {
  if (held) globalShortcut.unregister(held)
  held = null
  ok = true
  const want = appHotkeyFrom(kvGet(KEY))
  if (want === NO_APP_HOTKEY || process.env.COVE_USER_DATA) return
  try {
    ok = globalShortcut.register(want, pressed)
  } catch {
    ok = false
  }
  if (ok) held = want
}

export function setAppHotkey(accelerator: string): AppHotkeyState {
  kvSet(KEY, appHotkeyFrom(accelerator))
  register()
  const state = appHotkey()
  broadcastToWindows('app:hotkey', state)
  return state
}

export function registerAppHotkey(h: NonNullable<typeof host>): void {
  host = h
  ipcMain.handle('app:hotkey', () => appHotkey())
  ipcMain.handle('app:set-hotkey', (_e, accelerator: string) => setAppHotkey(String(accelerator)))
  void app.whenReady().then(register)
  app.on('will-quit', () => {
    if (held) globalShortcut.unregister(held)
  })
}
