import { app, BrowserWindow, ipcMain } from 'electron'
import { healthLog } from './health'
import { existsSync } from 'fs'
import { join } from 'path'
import { scaleToWindowPixels } from './browser'

/**
 * The simulator's screen inside our window: `native/simview.node`.
 *
 * Not a stream. The module puts the device's own framebuffer (an IOSurface,
 * the buffer Apple's simulator window draws) into a native layer over the
 * pane, and the window server composites it like any other layer: no encode,
 * no copy, no IPC per frame, at whatever rate the device draws.
 *
 * The renderer still owns the pane. It measures where the picture goes and
 * sends that here; it keeps a transparent box of the same size underneath for
 * the pointer (the native view lets every click through), so taps, drags and
 * keys work exactly as they did over the streamed picture. Like the browser's
 * native view, nothing in HTML can draw over it, so the pane hides it while an
 * overlay is open.
 *
 * Any failure (an older Xcode, the private API moved) is reported back and
 * the pane falls back to the stream, which still works everywhere.
 */

interface SimViewModule {
  attach(o: { view: Buffer; udid: string }): {
    id: number
    width: number
    height: number
    screens: number
    device: string
  }
  size(id: number): { width?: number; height?: number }
  setBounds(
    id: number,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    rotation: number
  ): void
  setVisible(id: number, on: boolean): void
  detach(id: number): void
  screens(udid: string): { width: number; height: number; lit: boolean }[]
  /** What the native heartbeat last saw, from memory (no CoreSimulator call). */
  health?(id: number): { screens: number; width: number; height: number }
}

let mod: SimViewModule | null | undefined

function load(): SimViewModule | null {
  if (mod !== undefined) return mod
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'simview.node')]
    : [join(__dirname, '../../native/simview.node'), join(process.cwd(), 'native/simview.node')]
  const path = candidates.find((p) => existsSync(p))
  mod = null
  if (!path || process.platform !== 'darwin') return mod
  try {
    const m = { exports: {} as SimViewModule }
    process.dlopen(m as unknown as NodeJS.Module, path)
    mod = m.exports
  } catch (err) {
    console.error('[simview] could not load:', String(err))
  }
  return mod
}

interface Attached {
  id: number
  win: BrowserWindow
  pxWidth: number
  pxHeight: number
  timer: ReturnType<typeof setInterval>
}

/** One per device on screen. The key is the device; a window shows one pane per device. */
const attached = new Map<string, Attached>()

export function isViewing(udid: string): boolean {
  return attached.has(udid)
}

type ToPoints = (w: number, h: number, name: string) => { width: number; height: number }

function detach(udid: string): void {
  const a = attached.get(udid)
  if (!a) return
  attached.delete(udid)
  clearInterval(a.timer)
  try {
    load()?.detach(a.id)
  } catch {
    /* the window it lived in is gone */
  }
}

export function detachAllSimViews(): void {
  for (const udid of [...attached.keys()]) detach(udid)
}

export function registerSimViewIpc(toPoints: ToPoints, onGone: (udid: string) => void): void {
  // Why a pane streamed, and for how long, in memory.log: one line per device
  // per reason, and one when the screen embeds. "Why is it streaming?" has an
  // answer on the user's Mac, not only in a guess.
  const refusedSince = new Map<string, { at: number; why: string }>()
  const note = (udid: string, why: string | null): void => {
    const prev = refusedSince.get(udid)
    if (why === null) {
      if (prev) {
        healthLog(
          `simview ${udid.slice(0, 8)} embedded after ${Math.round((Date.now() - prev.at) / 1000)}s (was: ${prev.why})`
        )
        refusedSince.delete(udid)
      }
      return
    }
    if (!prev) refusedSince.set(udid, { at: Date.now(), why })
    if (!prev || prev.why !== why) healthLog(`simview ${udid.slice(0, 8)} not embedded: ${why}`)
    if (prev && prev.why !== why) prev.why = why
  }
  ipcMain.handle('sim:view-attach', (e, udid: string) => {
    const m = load()
    if (!m) {
      note(udid, 'simview is not available')
      return { ok: false, error: 'simview is not available' }
    }
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: 'no window' }
    // A remount for the same device (the pane re-rendered, a chat switch) takes
    // the view over rather than stacking a second one beside it.
    detach(udid)
    try {
      const info = m.attach({ view: win.getNativeWindowHandle(), udid })
      const name = info.device
      // Follow the screen: a foldable switching screens changes its size, and
      // the pane maps taps by size. Also the only sign a device has gone.
      let misses = 0
      const timer = setInterval(() => {
        const a = attached.get(udid)
        if (!a || win.isDestroyed()) return detach(udid)
        // What the native heartbeat last saw (off the main thread); screens()
        // is a call into CoreSimulator here, which waits while it is busy and
        // froze the app — kept only for an older module without health().
        let lit = false
        try {
          lit = m.health ? m.health(a.id).screens > 0 : m.screens(udid).length > 0
        } catch {
          lit = false
        }
        if (!lit) {
          // Two in a row, so a device mid-reboot of its display is not taken for gone.
          if (++misses >= 2) {
            detach(udid)
            if (!win.isDestroyed()) win.webContents.send(`sim:gone:${udid}`)
            onGone(udid)
          }
          return
        }
        misses = 0
        const s = m.size(a.id)
        if (s.width && s.height && (s.width !== a.pxWidth || s.height !== a.pxHeight)) {
          a.pxWidth = s.width
          a.pxHeight = s.height
          const pt = toPoints(s.width, s.height, name)
          win.webContents.send(`sim:view-size:${udid}`, { width: pt.width, height: pt.height })
        }
      }, 1000)
      attached.set(udid, { id: info.id, win, pxWidth: info.width, pxHeight: info.height, timer })
      win.once('closed', () => detach(udid))
      const pt = toPoints(info.width, info.height, name)
      note(udid, null)
      return { ok: true, width: pt.width, height: pt.height, screens: info.screens, device: name }
    } catch (err) {
      const why = String((err as Error)?.message ?? err)
      note(udid, why)
      return { ok: false, error: why }
    }
  })

  ipcMain.on(
    'sim:view-bounds',
    (
      _e,
      udid: string,
      rect: { x: number; y: number; width: number; height: number },
      radius: number,
      rotation: number
    ) => {
      const a = attached.get(udid)
      const m = load()
      if (!a || !m || a.win.isDestroyed()) return
      // The page measures in CSS pixels; the window is in points. Same number
      // only at 100% zoom — the browser pane learned that the hard way.
      const zoom = a.win.webContents.getZoomFactor()
      const r = scaleToWindowPixels(rect, zoom)
      try {
        m.setBounds(a.id, r.x, r.y, r.width, r.height, (radius || 0) * (zoom || 1), rotation || 0)
      } catch {
        /* gone mid-update */
      }
    }
  )

  ipcMain.on('sim:view-visible', (_e, udid: string, on: boolean) => {
    const a = attached.get(udid)
    if (!a) return
    try {
      load()?.setVisible(a.id, !!on)
    } catch {
      /* gone mid-update */
    }
  })

  ipcMain.on('sim:view-detach', (_e, udid: string) => detach(udid))
}
