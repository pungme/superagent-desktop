import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { hookBus } from './hooks'
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
let status: 'idle' | 'working' | 'needs-you' = 'idle'

function icon(state: 'idle' | 'working' | 'needs-you', linked: boolean): Electron.NativeImage {
  // A 16pt template glyph drawn as SVG: a phone outline with a status dot.
  const dot =
    state === 'working' ? '#3ecf8e' : state === 'needs-you' ? '#f0b429' : linked ? '#000' : '#999'
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <rect x="9" y="3" width="14" height="26" rx="3" fill="none" stroke="#000" stroke-width="2.5"/>
    <rect x="13" y="24" width="6" height="2" rx="1" fill="#000"/>
    <circle cx="25" cy="7" r="5" fill="${dot}" stroke="#fff" stroke-width="1.5"/>
  </svg>`
  const img = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  )
  const sized = img.resize({ width: 16, height: 16 })
  // Only the plain (no colored dot) glyph can be a template image.
  sized.setTemplateImage(state === 'idle' && linked)
  return sized
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
  tray.setImage(icon(status, linked))
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

/** Show the tray while at least one phone is paired; hide it otherwise. */
export function syncTray(): void {
  const want = listDevices().length > 0
  if (want && !tray) {
    tray = new Tray(icon('idle', false))
    tray.on('click', showWindow)
    // What is working changes all the time: read it again as the pointer
    // arrives, so the menu that opens is the one true now.
    tray.on('mouse-enter', rebuild)
  } else if (!want && tray) {
    tray.destroy()
    tray = null
  }
  rebuild()
}

export function startTray(): void {
  syncTray()
  hookBus.on('event', (e: { status?: typeof status }) => {
    if (e.status) {
      status = e.status
      rebuild()
    }
  })
}

export function refreshTray(): void {
  syncTray()
}
