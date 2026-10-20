import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import { hookBus } from './hooks'
import { GLYPH_SIZE, trayGlyph, type TrayState } from './tray-glyph'
import { workspaceStatuses } from './companion/status'
import { companionState } from './companion'
import { listDevices } from './companion/devices'
import { broadcastToWindows } from './util'
import {
  listAllChats,
  DESKTOP_WORKSPACE_ID,
  ensureDesktopWorkspace,
  getWorkspace,
  kvGet
} from './store'
import { detectProjectIcon, iconKvKey } from './project-icon'
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
/**
 * Put the right picture up — only when it changes. The working state used to
 * breathe (two frames, every 700 ms, for as long as any chat had an agent on
 * it — on a busy Mac, always). Each frame was a menu-bar redraw through
 * WindowServer, 86 a minute, and WindowServer logged two errors for every one
 * of them during the 2026-10-20 freeze investigation. A still mark says
 * "working" just as well.
 */
function paint(): void {
  if (!tray) return
  const state = currentState()
  const linked = companionState().relay.state === 'connected'
  const key = `${state}:${linked}`
  if (key === shown) return
  shown = key
  tray.setImage(icon(state, linked))
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
/** A small round dot, coloured: what the Mac's own menus use for a status. */
const dots = new Map<string, Electron.NativeImage>()
function statusDot(rgb: [number, number, number]): Electron.NativeImage {
  const key = rgb.join(',')
  const hit = dots.get(key)
  if (hit) return hit
  const n = 32
  const buf = Buffer.alloc(n * n * 4)
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x + 0.5 - 16, y + 0.5 - 16)
      const a = Math.max(0, Math.min(1, 7 - d + 0.5))
      const i = (y * n + x) * 4
      // BGRA, premultiplied.
      buf[i] = Math.round(rgb[2] * a)
      buf[i + 1] = Math.round(rgb[1] * a)
      buf[i + 2] = Math.round(rgb[0] * a)
      buf[i + 3] = Math.round(255 * a)
    }
  const img = nativeImage.createFromBitmap(buf, { width: n, height: n, scaleFactor: 2 })
  dots.set(key, img)
  return img
}
const GREEN: [number, number, number] = [52, 199, 89]
const AMBER: [number, number, number] = [255, 159, 10]
const GREY: [number, number, number] = [142, 142, 147]

/**
 * A project's own icon at menu size, as the sidebar shows it: the one set by
 * hand, else what is in the folder, else the system's folder. Kept, since
 * the menu is rebuilt every time the pointer reaches the menu bar.
 */
const projectIcons = new Map<string, Electron.NativeImage>()
function projectIcon(workspaceId: string, computer: boolean): Electron.NativeImage {
  const hit = projectIcons.get(workspaceId)
  if (hit) return hit
  let img: Electron.NativeImage | null = null
  const ws = computer ? undefined : getWorkspace(workspaceId)
  try {
    const custom = kvGet(iconKvKey(workspaceId))
    const found = custom
      ? { dataUri: custom }
      : ws?.path && ws.kind !== 'browser'
        ? detectProjectIcon(ws.path)
        : null
    if (found && 'dataUri' in found) {
      const pic = nativeImage.createFromDataURL(found.dataUri)
      if (!pic.isEmpty()) img = pic.resize({ width: 16, height: 16, quality: 'best' })
    }
  } catch {
    /* unreadable: the folder stands in */
  }
  if (!img) {
    const named = nativeImage.createFromNamedImage(
      computer ? 'NSComputer' : ws?.kind === 'browser' ? 'NSNetwork' : 'NSFolder'
    )
    img = named.isEmpty() ? statusDot(GREY) : named.resize({ width: 16, height: 16 })
  }
  projectIcons.set(workspaceId, img)
  return img
}

/** "2 h ago", "yesterday": when a conversation was last used. */
function ago(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
  if (s < 2 * 86_400) return 'yesterday'
  return `${Math.floor(s / 86_400)} days ago`
}

/**
 * The chats to offer: the ones working now, then the latest used. A click on
 * the menu bar is a look at what is going on, and a way straight to it.
 *
 * Each is a conversation's title with its project under it, as macOS's own
 * menus show a second line, and the project's icon beside it — a working one
 * gets a green dot instead, since that is what you came to see.
 */
function chatItems(): Electron.MenuItemConstructorOptions[] {
  const names = new Map(dotProjects().map((p) => [p.id, p.name]))
  const home = ensureDesktopWorkspace().workspaceId
  const chats = listAllChats()
    .filter((c) => c.title)
    .map((c) => {
      const computer = c.workspaceId === home || c.workspaceId === DESKTOP_WORKSPACE_ID
      return {
        ...c,
        computer,
        project: computer ? 'Computer' : (names.get(c.workspaceId) ?? ''),
        running: isGenerating(c.id)
      }
    })
    .filter((c) => c.project)
  const item = (c: (typeof chats)[number]): Electron.MenuItemConstructorOptions => ({
    label: short(c.title ?? 'New chat'),
    sublabel: c.running ? `${c.project} · working` : `${c.project} · ${ago(c.updatedAt)}`,
    icon: c.running ? statusDot(GREEN) : projectIcon(c.workspaceId, c.computer),
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
    out.push({ type: 'header', label: 'Working now' }, ...running.slice(0, 8).map(item))
    out.push({ type: 'separator' })
  }
  if (recent.length) {
    out.push({ type: 'header', label: 'Recent' }, ...recent.map(item))
    out.push({ type: 'separator' })
  }
  return out
}

const short = (t: string): string => {
  const one = t.replace(/\s+/g, ' ').trim()
  return one.length > 44 ? `${one.slice(0, 43)}…` : one
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
      // How the phone link stands, the way macOS shows a connection: a
      // coloured dot and a line under it, not a greyed-out sentence.
      {
        label: linked ? 'Connected to your phone' : 'Not connected',
        sublabel: linked
          ? `${phones} phone${phones === 1 ? '' : 's'} paired`
          : `Relay: ${s.relay.state}`,
        icon: statusDot(linked ? GREEN : s.relay.state === 'connecting' ? AMBER : GREY),
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
  // A slow beat that notices a chat starting or finishing; paint only redraws
  // when the state is different.
  if (tray && !beat) beat = setInterval(paint, 2000)
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
