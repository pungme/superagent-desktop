import { askToOpen } from './open-request'
import { linkDot } from './dot-link'
import { bringAppForward } from './app-hotkey'
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
import { glanceForDot } from './computer-use'
import { dotBounds, DOT_H as H, DOT_W as W, pointOnDot } from './dot-bounds'
import { QUIET, showInactiveForReal } from './quiet'
import {
  dotHotkeyFrom,
  NO_DOT_HOTKEY,
  talkHotkeyFrom,
  type DotHotkeyState
} from '../shared/dot-hotkey'

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

let win: BrowserWindow | null = null
/** Chats the dot started: only their events are passed on to it. */
const watched = new Set<string>()
/**
 * Out of the way because Superagent's own window is in front. The dot is for
 * asking from anywhere else; with the app up you are already here. It comes
 * back the moment you go to another app, or close or minimise the window.
 */
let awayForApp = false

/** A conversation the dot started, so a tool call in it was asked from the dot. */
export function dotOwns(chatId: string | null | undefined): boolean {
  return !!chatId && watched.has(chatId)
}

/**
 * Asked, from the dot, to switch to a project: the dot's own target moves
 * there, and the next request goes to it. Superagent's window stays wherever
 * it is, which from the dot is out of the way.
 */
export function switchDotProject(workspaceId: string): boolean {
  if (!win || win.isDestroyed()) return false
  if (!dotProjects().some((p) => p.id === workspaceId)) return false
  send('dot:switch-project', workspaceId)
  return true
}

/**
 * Left out of the picture while an agent photographs the screen to see it: it
 * should see what is under the tile, not the tile. Only for that moment; the
 * rest of the time the dot is in your own screenshots like anything else (it
 * was out of every capture before, which made it impossible to show anyone).
 */
let curtains = 0
const CURTAIN_MS = 120
export async function outOfShot<T>(take: () => Promise<T>): Promise<T> {
  if (!win || win.isDestroyed() || !win.isVisible()) return take()
  curtains += 1
  if (curtains === 1) {
    win.setContentProtection(true)
    // The window server takes a moment to leave it out.
    await new Promise((r) => setTimeout(r, CURTAIN_MS))
  }
  try {
    return await take()
  } finally {
    curtains -= 1
    if (curtains === 0 && win && !win.isDestroyed()) win.setContentProtection(false)
  }
}

/** One of the app's own windows, as against the dot: the window in question. */
function appWindow(w: BrowserWindow | null | undefined): w is BrowserWindow {
  return !!w && w !== win && !w.isDestroyed()
}

/** Whether one of the app's own windows is in front right now. */
function appInFrontNow(): boolean {
  return BrowserWindow.getAllWindows().some(
    (w) => appWindow(w) && w.isFocused() && w.isVisible() && !w.isMinimized()
  )
}

/** On screen, never focused: the tile is not where the keyboard goes. */
function reveal(): void {
  if (!win || win.isDestroyed() || win.isVisible()) return
  if (!QUIET) win.showInactive()
  // A hidden test run that is checking how the tile really looks on screen:
  // the tile alone, never focused, with the app's own window still hidden.
  else if (process.env.COVE_E2E_SHOW_DOT === '1') showInactiveForReal.call(win)
}

/** Superagent's own window came to the front (true), or left it (false). */
function appInFront(front: boolean): void {
  awayForApp = front
  if (!win || win.isDestroyed()) return
  if (front) {
    // The panel, if open, closes with it: a question half-typed into a hidden
    // window would be a surprise when the tile comes back.
    send('dot:away')
    win.hide()
  } else reveal()
}

/**
 * Off until turned on, in Settings → General or while setting up: a tile over
 * every app is not something to find on your screen unasked. (A test that is
 * about the dot has it on from the start.)
 */
export function dotEnabled(): boolean {
  const v = kvGet(ENABLED_KEY)
  if (v === '1') return true
  return v !== '0' && process.env.COVE_E2E_DOT === '1'
}

/**
 * The screen the dot is on: the one you are on, which is where the pointer is.
 * It follows you there (see follow) rather than waiting on the main screen for
 * someone working on the other one.
 */
let onDisplay: number | null = null

function place(): void {
  if (!win || win.isDestroyed()) return
  // A test run keeps to the main screen: where the pointer of whoever is
  // using the Mac happens to be is not its business.
  const here = process.env.COVE_USER_DATA
    ? screen.getPrimaryDisplay()
    : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  onDisplay = here.id
  // Always that screen's corner: it is not dragged about.
  win.setBounds(
    dotBounds(
      null,
      screen.getAllDisplays().map((d) => d.workArea),
      here.workArea
    )
  )
}

/** Move to the screen the pointer went to. Not with the panel open: it would jump mid-sentence. */
function follow(): void {
  if (!win || win.isDestroyed() || panelOpen || process.env.COVE_USER_DATA) return
  if (screen.getAllDisplays().length < 2) return
  const here = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  if (here.id !== onDisplay) place()
}

function send(channel: string, payload?: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

/** The panel is open: its whole window can hold buttons, an Allow among them. */
let panelOpen = false

/**
 * Whether a point on the screen is on the dot: its whole window while the
 * panel is open, otherwise only the tile in its corner. Computer use asks,
 * so that an agent never clicks Superagent's own controls.
 */
export function dotCovers(x: number, y: number): boolean {
  if (!win || win.isDestroyed() || !win.isVisible()) return false
  return pointOnDot(win.getBounds(), panelOpen, x, y)
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
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  // Everything is see-through and click-through until the page says otherwise.
  win.setIgnoreMouseEvents(true, { forward: true })
  place()
  if (is.dev && process.env['ELECTRON_RENDERER_URL'])
    void win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#dot`)
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'dot' })
  win.once('ready-to-show', () => {
    // Made while the app's window is in front (turned on in Settings, say):
    // it waits for the window to go.
    if (appInFrontNow()) awayForApp = true
    else reveal()
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
      else if (!panelOpen) place()
      win?.show()
      win?.focus()
      send('dot:summon')
    })
  } catch {
    hotkeyOk = false
  }
  if (hotkeyOk) held = want
}

const TALK_KEY = 'dot.talkHotkey'
let talkHeld: string | null = null
let talkOk = true

export function talkHotkey(): DotHotkeyState {
  return { hotkey: talkHotkeyFrom(kvGet(TALK_KEY)), ok: talkOk }
}

/** The shortcut for speaking to the dot: it opens listening; pressed again, it sends. */
function registerTalkHotkey(): void {
  if (talkHeld) globalShortcut.unregister(talkHeld)
  talkHeld = null
  talkOk = true
  const want = talkHotkeyFrom(kvGet(TALK_KEY))
  if (!dotEnabled() || want === NO_DOT_HOTKEY) return
  try {
    talkOk = globalShortcut.register(want, () => {
      if (!win || win.isDestroyed()) createDot()
      win?.show()
      win?.focus()
      send('dot:talk')
    })
  } catch {
    talkOk = false
  }
  if (talkOk) talkHeld = want
}

export function setTalkHotkey(accelerator: string): DotHotkeyState {
  kvSet(TALK_KEY, talkHotkeyFrom(accelerator))
  registerTalkHotkey()
  const state = talkHotkey()
  broadcastToWindows('dot:talk-hotkey', state)
  return state
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
  registerTalkHotkey()
  broadcastToWindows('dot:enabled', on)
  broadcastToWindows('dot:hotkey', dotHotkey())
  return on
}

export function registerDot(): void {
  linkDot({ owns: dotOwns, switchTo: switchDotProject })
  // Out of the way while the app's own window is in front, back when it is not.
  // Any window of the app's counts; a window closing, hiding or minimising is
  // checked against the rest, since a dialog going does not mean the app did.
  app.on('browser-window-focus', (_e, w) => {
    if (appWindow(w)) appInFront(true)
  })
  app.on('browser-window-blur', (_e, w) => {
    if (w !== win) appInFront(appInFrontNow())
  })
  app.on('browser-window-created', (_e, w) => {
    if (w === win) return
    const left = (): void => appInFront(appInFrontNow())
    w.on('hide', left)
    w.on('minimize', left)
    w.on('closed', left)
  })
  ipcMain.handle('dot:away', () => awayForApp)
  // Events are the quick way; this is the sure way. Whatever focus event went
  // missing (the app switcher, a Space change, a window closing as another
  // opened), within a moment the dot is where it should be: hidden while one
  // of the app's windows is in front, on screen otherwise. The first version
  // trusted the events alone and the dot stayed gone.
  setInterval(() => {
    if (!win || win.isDestroyed() || !dotEnabled() || QUIET) return
    const front = appInFrontNow()
    if (front !== awayForApp || front === win.isVisible()) appInFront(front)
  }, 600).unref()
  // A hidden test run stands in for the agent, and so for dot:ask; this is how
  // it says a conversation is the dot's.
  if (process.env.COVE_E2E_DOT === '1')
    (globalThis as { dotOwn?: (id: string) => void }).dotOwn = (id) => {
      watched.add(id)
    }
  ipcMain.handle('dot:enabled', () => dotEnabled())
  ipcMain.handle('dot:set-enabled', (_e, on: boolean) => setDotEnabled(!!on))
  ipcMain.handle('dot:projects', () => dotProjects())
  ipcMain.handle('dot:hotkey', () => dotHotkey())
  ipcMain.handle('dot:talk-hotkey', () => talkHotkey())
  ipcMain.handle('dot:set-talk-hotkey', (_e, accelerator: string) =>
    setTalkHotkey(String(accelerator))
  )
  ipcMain.handle('dot:set-hotkey', (_e, accelerator: string) => setDotHotkey(String(accelerator)))

  /** The page is solid under the pointer (true) or see-through (false). */
  ipcMain.on('dot:solid', (_e, solid: boolean) => {
    if (!win || win.isDestroyed()) return
    win.setIgnoreMouseEvents(!solid, { forward: true })
  })
  /** The panel opened and wants the keyboard; closed, it gives it back. */
  ipcMain.on('dot:focus', (_e, want: boolean) => {
    panelOpen = !!want
    if (!win || win.isDestroyed()) return
    if (want) {
      win.show()
      win.focus()
    } else win.blur()
  })
  /** A request: a new chat in the chosen project, sent like a phone sends one. */
  ipcMain.handle('dot:ask', async (_e, workspaceId: string, text: string, into?: string) => {
    const said = String(text ?? '').trim()
    if (!said) return { ok: false as const, error: 'Nothing to send.' }
    // What was on screen when the question was asked — taken now, before
    // anything slow (cutting a branch, starting an agent) has had time to
    // change it. A question about "this error" is about the screen of the
    // moment it was typed, not the one three seconds later.
    const prior = into && watched.has(into) ? getChat(into) : undefined
    const seen = await glanceForDot(prior?.id ?? 'dot')
    const shot = seen ? [seen] : []
    // A follow-up: the same conversation, so it knows what was just said. Sent
    // the way a phone's next message is, which waits its turn if one is running.
    if (prior) {
      const sent = await askFromDot(prior.id, said, shot)
      return sent.ok
        ? { ok: true as const, chatId: prior.id, workspaceId: prior.workspaceId, saw: !!seen }
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
    const sent = await askFromDot(chatId, said, shot)
    if (!sent.ok) {
      watched.delete(chatId)
      return { ok: false as const, error: sent.error }
    }
    return { ok: true as const, chatId, workspaceId: wsId, saw: !!seen }
  })
  /** A project picked in the dot's list to go to, rather than to ask in. */
  ipcMain.on('dot:open-project', (_e, workspaceId: string) => {
    const id = String(workspaceId)
    if (!dotProjects().some((p) => p.id === id && p.kind !== 'computer')) return
    if (process.env.COVE_E2E_QUIET !== '1') bringAppForward()
    askToOpen(id, '')
  })
  ipcMain.handle('dot:stop', (_e, chatId: string) => stopFromDot(String(chatId)))
  ipcMain.handle('dot:answer', (_e, id: string, approve: boolean) =>
    resolveGate(String(id), !!approve, false, 'desktop')
  )
  /** "Open in Superagent": bring the main window up on that conversation. */
  ipcMain.on('dot:open', (_e, chatId: string) => {
    const chat = getChat(String(chatId))
    if (!chat) return
    // The window may have been closed: Superagent goes on without it, and
    // this is the way back in. It is opened again, and told where to go
    // once it is up (open-request.ts).
    if (process.env.COVE_E2E_QUIET !== '1') bringAppForward()
    askToOpen(chat.workspaceId, chat.id)
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
    registerTalkHotkey()
    // No event says the pointer changed screens; a look twice a second is
    // nothing, and only with a second screen is there anything to do.
    setInterval(follow, 500).unref()
    screen.on('display-removed', place)
    screen.on('display-metrics-changed', place)
  })
  app.on('will-quit', () => {
    if (held) globalShortcut.unregister(held)
    if (talkHeld) globalShortcut.unregister(talkHeld)
  })
}
