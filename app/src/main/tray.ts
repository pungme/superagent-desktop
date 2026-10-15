import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { hookBus } from './hooks'
import { GLYPH_SIZE, trayGlyph, type TrayState } from './tray-glyph'
import { workspaceStatuses } from './companion/status'
import { companionState } from './companion'
import { listDevices } from './companion/devices'
import { broadcastToWindows } from './util'
import { listAllChats, DESKTOP_WORKSPACE_ID, ensureDesktopWorkspace } from './store'
import { isGenerating } from './companion/log'
import { dotProjects } from './dot-projects'
import { askToOpen } from './open-request'
import { bringAppForward } from './app-hotkey'

/**
 * A menu-bar presence for when a phone is watching this Mac. Closing the
 * window keeps Superagent alive on macOS anyway; the tray makes that visible,
 * shows whether the relay link is up, and is a one-click way back.
 */
let tray: Tray | null = null

/**
 * The icon for a state. Drawn as pixels (tray-glyph.ts): nativeImage cannot
 * read SVG, which is why the icon used to be an empty, invisible gap.
 */
function icon(state: TrayState, linked: boolean, frame = 0): Electron.NativeImage {
  const img = nativeImage.createFromBitmap(trayGlyph(state, linked, frame), {
    width: GLYPH_SIZE,
    height: GLYPH_SIZE,
    scaleFactor: 2
  })
  // Template: macOS tints it to suit the menu bar, light or dark.
  img.setTemplateImage(true)
  return img
}

/**
 * What the icon says, from what is actually happening: a chat waiting on you
 * first, then any chat working. The last hook event from any chat, which this
 * used to follow, said "idle" the moment one of two working chats finished.
 */
function currentState(): TrayState {
  const statuses = [...workspaceStatuses().values()]
  if (statuses.includes('needs-you')) return 'needs-you'
  if (statuses.includes('working')) return 'working'
  return listAllChats().some((c) => isGenerating(c.id)) ? 'working' : 'idle'
}

let shown = ''
let frame = 0
/** Put the right picture up; while working, step the breathing dot. */
function paint(): void {
  if (!tray) return
  const state = currentState()
  const linked = companionState().relay.state === 'connected'
  if (state === 'working') frame++
  const key = `${state}:${linked}:${state === 'working' ? frame % 2 : 0}`
  if (key === shown) return
  shown = key
  tray.setImage(icon(state, linked, frame))
}

function showWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    app.emit('activate')
  }
}

/**
 * The chats to offer: the ones working now, then the latest used. A click on
 * the menu bar is a look at what is going on, and a way straight to it.
 */
function chatItems(): Electron.MenuItemConstructorOptions[] {
  const names = new Map(dotProjects().map((p) => [p.id, p.name]))
  const home = ensureDesktopWorkspace().workspaceId
  const chats = listAllChats()
    .filter((c) => c.title)
    .map((c) => ({
      ...c,
      project:
        c.workspaceId === home || c.workspaceId === DESKTOP_WORKSPACE_ID
          ? 'Computer'
          : (names.get(c.workspaceId) ?? ''),
      running: isGenerating(c.id)
    }))
    .filter((c) => c.project)
  const item = (c: (typeof chats)[number]): Electron.MenuItemConstructorOptions => ({
    label: `${c.running ? '● ' : ''}${short(c.title ?? 'New chat')} — ${c.project}`,
    click: () => {
      bringAppForward()
      askToOpen(c.workspaceId, c.id)
    }
  })
  const running = chats.filter((c) => c.running).sort((a, b) => b.updatedAt - a.updatedAt)
  const recent = chats
    .filter((c) => !c.running)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
  const out: Electron.MenuItemConstructorOptions[] = []
  if (running.length) {
    out.push({ label: 'Working now', enabled: false }, ...running.slice(0, 8).map(item))
    out.push({ type: 'separator' })
  }
  if (recent.length) {
    out.push({ label: 'Latest', enabled: false }, ...recent.map(item))
    out.push({ type: 'separator' })
  }
  return out
}

const short = (t: string): string => {
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > 48 ? `${one.slice(0, 47)}…` : one
}

function rebuild(): void {
  if (!tray) return
  const s = companionState()
  const linked = s.relay.state === 'connected'
  paint()
  const phones = s.devices.length
  tray.setToolTip(
    `Superagent — ${linked ? 'reachable by your phone' : 'not connected to the relay'}`
  )
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: linked
          ? `Reachable · ${phones} phone${phones === 1 ? '' : 's'}`
          : 'Relay: ' + s.relay.state,
        enabled: false
      },
      { type: 'separator' },
      ...chatItems(),
      { label: 'Open Superagent', click: showWindow },
      {
        label: 'Pair a phone…',
        click: () => {
          showWindow()
          broadcastToWindows('menu', 'settings:phone')
        }
      },
      { type: 'separator' },
      { label: 'Quit Superagent', role: 'quit' }
    ])
  )
}

let beat: ReturnType<typeof setInterval> | null = null

/** Show the tray while at least one phone is paired; hide it otherwise. */
export function syncTray(): void {
  const want = listDevices().length > 0
  if (want && !tray) {
    shown = ''
    tray = new Tray(icon('idle', false))
    tray.on('click', showWindow)
    // What is working changes all the time: read it again as the pointer
    // arrives, so the menu that opens is the one true now.
    tray.on('mouse-enter', rebuild)
  } else if (!want && tray) {
    tray.destroy()
    tray = null
  }
  // A slow beat: steps the working dot and notices a chat starting or finishing.
  if (tray && !beat) beat = setInterval(paint, 700)
  if (!tray && beat) {
    clearInterval(beat)
    beat = null
  }
  rebuild()
}

export function startTray(): void {
  syncTray()
  hookBus.on('event', (e: { status?: TrayState }) => {
    if (e.status) rebuild()
  })
}

export function refreshTray(): void {
  syncTray()
}
