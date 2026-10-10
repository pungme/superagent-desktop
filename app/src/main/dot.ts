import { app, BrowserWindow, globalShortcut, ipcMain, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import {
  createChat,
  DESKTOP_WORKSPACE_ID,
  ensureDesktopWorkspace,
  getChat,
  getWorkspace,
  kvGet,
  kvSet,
  markPendingBranch
} from './store'
import { broadcastToWindows } from './util'
import { logBus } from './companion/log'
import { askFromDot, stopFromDot } from './companion/rpc'
import { resolveGate } from './hooks'
import { dotProjects } from './dot-projects'
import { dotBounds, DOT_H as H, DOT_W as W } from './dot-bounds'
import { QUIET, showInactiveForReal } from './quiet'
import { dotHotkeyFrom, NO_DOT_HOTKEY, type DotHotkeyState } from '../shared/dot-hotkey'

/**
 * The dot: Superagent as a small tile floating over everything, bottom right.
 * Click it or press the hotkey, say where (Computer or a project) and what, and
 * the answer comes back beside it — without opening the main window.
 *
 * It is a window of its own: frameless, transparent, above every app and on
 * every Space. It is as big as its open panel all the time and lets the mouse
 * through wherever nothing is drawn, which is simpler and steadier than
 * resizing a window as a panel opens (the page says where it is solid).
 *
 * A request is an ordinary chat: a new conversation in the chosen project,
 * sent the way a phone sends one, so it has its own branch when it changes
 * code and is there in Superagent afterwards like any other. The dot only
 * watches that chat's events.
 */

const ENABLED_KEY = 'dot.enabled'
const POS_KEY = 'dot.position'

let win: BrowserWindow | null = null
/** Chats the dot started: only their events are passed on to it. */
const watched = new Set<string>()

export function dotEnabled(): boolean {
  return kvGet(ENABLED_KEY) !== '0'
}

function savedPosition(): { x: number; y: number } | null {
  try {
    const p = JSON.parse(kvGet(POS_KEY) ?? 'null') as { x?: unknown; y?: unknown } | null
    return p && typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null
  } catch {
    return null
  }
}

function place(): void {
  if (!win || win.isDestroyed()) return
  win.setBounds(
    dotBounds(
      savedPosition(),
      screen.getAllDisplays().map((d) => d.workArea),
      screen.getPrimaryDisplay().workArea
    )
  )
}

function send(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** The app's own window, as opposed to the dot. */
function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => w !== win && !w.isDestroyed()) ?? null
}

export function isDotWindow(w: BrowserWindow | null | undefined): boolean {
  return !!w && w === win
}

function createDot(): void {
  if (win && !win.isDestroyed()) return
  win = new BrowserWindow({
    width: W,
    height: H,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    // A panel, not a document window: it must not take the main window's place
    // as "the app's window", nor show in Mission Control as one.
    type: 'panel',
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, 'floating')
  // Left out of screen captures: an agent using the Mac photographs the screen
  // to see it, and should see what is under the tile, not the tile. (It also
  // keeps the tile out of a screen share.)
  win.setContentProtection(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Everything is see-through and click-through until the page says otherwise.
  win.setIgnoreMouseEvents(true, { forward: true })
  place()
  if (is.dev && process.env['ELECTRON_RENDERER_URL'])
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#dot`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'dot' })
  win.once('ready-to-show', () => {
    if (!QUIET) win?.showInactive()
    // A hidden test run that is checking how the tile really looks on screen:
    // the tile alone, never focused, with the app's own window still hidden.
    else if (process.env.COVE_E2E_SHOW_DOT === '1' && win) showInactiveForReal.call(win)
  })
  win.on('closed', () => {
    win = null
  })
}

function destroyDot(): void {
  if (win && !win.isDestroyed()) win.destroy()
  win = null
}

const HOTKEY_KEY = 'dot.hotkey'
/** What is registered now, so it can be let go of before another is taken. */
let held: string | null = null
/** Whether the system gave us the chosen shortcut. */
let hotkeyOk = true

export function dotHotkey(): DotHotkeyState {
  return { hotkey: dotHotkeyFrom(kvGet(HOTKEY_KEY)), ok: hotkeyOk }
}

/**
 * Take the chosen shortcut, letting go of the last. The system refuses one
 * another app already has, without a word: `register` just answers false. That
 * is kept, so Settings can say the shortcut is taken instead of leaving a
 * shortcut that does nothing.
 */
function registerHotkey(): void {
  if (held) globalShortcut.unregister(held)
  held = null
  hotkeyOk = true
  const want = dotHotkeyFrom(kvGet(HOTKEY_KEY))
  if (!dotEnabled() || want === NO_DOT_HOTKEY) return
  try {
    hotkeyOk = globalShortcut.register(want, () => {
      if (!win || win.isDestroyed()) createDot()
      win?.show()
      win?.focus()
      send('dot:summon')
    })
  } catch {
    hotkeyOk = false
  }
  if (hotkeyOk) held = want
}

export function setDotHotkey(accelerator: string): DotHotkeyState {
  kvSet(HOTKEY_KEY, dotHotkeyFrom(accelerator))
  registerHotkey()
  const state = dotHotkey()
  broadcastToWindows('dot:hotkey', state)
  return state
}

export function setDotEnabled(on: boolean): boolean {
  kvSet(ENABLED_KEY, on ? '1' : '0')
  if (on) createDot()
  else destroyDot()
  registerHotkey()
  broadcastToWindows('dot:enabled', on)
  broadcastToWindows('dot:hotkey', dotHotkey())
  return on
}

export function registerDot(): void {
  ipcMain.handle('dot:enabled', () => dotEnabled())
  ipcMain.handle('dot:set-enabled', (_e, on: boolean) => setDotEnabled(!!on))
  ipcMain.handle('dot:projects', () => dotProjects())
  ipcMain.handle('dot:hotkey', () => dotHotkey())
  ipcMain.handle('dot:set-hotkey', (_e, accelerator: string) => setDotHotkey(String(accelerator)))

  /** The page is solid under the pointer (true) or see-through (false). */
  ipcMain.on('dot:solid', (_e, solid: boolean) => {
    if (!win || win.isDestroyed()) return
    win.setIgnoreMouseEvents(!solid, { forward: true })
  })
  /** The panel opened and wants the keyboard; closed, it gives it back. */
  ipcMain.on('dot:focus', (_e, want: boolean) => {
    if (!win || win.isDestroyed()) return
    if (want) {
      win.show()
      win.focus()
    } else win.blur()
  })
  /** Dragged by its tile. */
  ipcMain.on('dot:move', (_e, dx: number, dy: number) => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    win.setBounds({ x: b.x + Math.round(dx), y: b.y + Math.round(dy), width: W, height: H })
  })
  ipcMain.on('dot:moved', () => {
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    kvSet(POS_KEY, JSON.stringify({ x: b.x, y: b.y }))
  })

  /** A request: a new chat in the chosen project, sent like a phone sends one. */
  ipcMain.handle('dot:ask', async (_e, workspaceId: string, text: string, into?: string) => {
    const said = String(text ?? '').trim()
    if (!said) return { ok: false as const, error: 'Nothing to send.' }
    // A follow-up: the same conversation, so it knows what was just said. Sent
    // the way a phone's next message is, which waits its turn if one is running.
    const prior = into && watched.has(into) ? getChat(into) : undefined
    if (prior) {
      const sent = await askFromDot(prior.id, said)
      return sent.ok
        ? { ok: true as const, chatId: prior.id, workspaceId: prior.workspaceId }
        : { ok: false as const, error: sent.error }
    }
    const wsId =
      workspaceId === DESKTOP_WORKSPACE_ID ? ensureDesktopWorkspace().workspaceId : workspaceId
    if (!getWorkspace(wsId)) return { ok: false as const, error: 'That project is gone.' }
    const chatId = createChat(wsId)
    // A project chat gets its own branch the moment it is about to change code.
    if (wsId !== DESKTOP_WORKSPACE_ID) markPendingBranch(chatId)
    watched.add(chatId)
    broadcastToWindows('projects:changed', {})
    const sent = await askFromDot(chatId, said)
    if (!sent.ok) {
      watched.delete(chatId)
      return { ok: false as const, error: sent.error }
    }
    return { ok: true as const, chatId, workspaceId: wsId }
  })
  ipcMain.handle('dot:stop', (_e, chatId: string) => stopFromDot(String(chatId)))
  ipcMain.handle('dot:answer', (_e, id: string, approve: boolean) =>
    resolveGate(String(id), !!approve, false, 'desktop')
  )
  /** "Open in Superagent": bring the main window up on that conversation. */
  ipcMain.on('dot:open', (_e, chatId: string) => {
    const chat = getChat(String(chatId))
    const main = mainWindow()
    if (!chat || !main) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    app.focus({ steal: true })
    main.webContents.send('dot:open-chat', { workspaceId: chat.workspaceId, chatId: chat.id })
  })

  logBus.on('event', ({ event }: { event: { chatId: string; data: unknown } }) => {
    if (watched.has(event.chatId)) send('dot:event', { chatId: event.chatId, data: event.data })
  })
  logBus.on('delta', (p: { chatId: string; text: string }) => {
    if (watched.has(p.chatId)) send('dot:delta', p)
  })

  // Never in a test run unless the test is about the dot: a second window would
  // be "the first window" to some of them.
  const wanted = process.env.COVE_USER_DATA ? process.env.COVE_E2E_DOT === '1' : true
  if (!wanted) return
  void app.whenReady().then(() => {
    if (dotEnabled()) createDot()
    registerHotkey()
    screen.on('display-removed', place)
    screen.on('display-metrics-changed', place)
  })
  app.on('will-quit', () => {
    if (held) globalShortcut.unregister(held)
  })
}
