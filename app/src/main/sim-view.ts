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
 * All CoreSimulator work (device lookup, displayPorts XPC, damage callback
 * registration/unregistration, heartbeat) runs off the main thread on a
 * per-device serial queue, and attach is guarded by a timeout + per-UDID
 * in-flight lock. If a simulator wedges inside CoreSimulator's synchronous XPC,
 * attaching times out cleanly and falls back to the stream without freezing the
 * app or blocking other simulators.
 */

export interface SimViewAttachInfo {
  id: number
  width: number
  height: number
  screens: number
  device: string
}

export interface SimViewModule {
  attach(o: { view: Buffer; udid: string }): SimViewAttachInfo
  attachAsync?(o: { view: Buffer; udid: string }): Promise<SimViewAttachInfo>
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

/** Max time to wait for CoreSimulator to hand back a display port on attach. */
const ATTACH_TIMEOUT_MS = 5000

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

interface PendingAttach {
  cancelled: boolean
}

export type ToPoints = (w: number, h: number, name: string) => { width: number; height: number }

export type AttachResult =
  | { ok: true; width: number; height: number; screens: number; device: string }
  | { ok: false; error: string }

export interface SimViewController {
  isViewing: (udid: string) => boolean
  attach: (win: BrowserWindow, udid: string) => Promise<AttachResult>
  setBounds: (
    udid: string,
    rect: { x: number; y: number; width: number; height: number },
    radius: number,
    rotation: number
  ) => void
  setVisible: (udid: string, on: boolean) => void
  detach: (udid: string) => void
  detachAll: () => void
}

export function createSimViewController(opts: {
  load: () => SimViewModule | null
  toPoints: ToPoints
  onGone: (udid: string) => void
  log: (line: string) => void
  attachTimeoutMs?: number
}): SimViewController {
  const { load: getMod, toPoints, onGone, log } = opts
  const timeoutMs = opts.attachTimeoutMs ?? ATTACH_TIMEOUT_MS

  /** One per device on screen. The key is the device; a window shows one pane per device. */
  const attached = new Map<string, Attached>()
  /**
   * One in-flight native attach per UDID. If CoreSimulator wedges on a device,
   * the attempt stays marked here until the native call eventually returns, so
   * retries never pile up extra background threads or XPC calls for that device.
   */
  const pending = new Map<string, PendingAttach>()

  // Why a pane streamed, and for how long, in memory.log: one line per device
  // per reason, and one when the screen embeds.
  const refusedSince = new Map<string, { at: number; why: string }>()
  const note = (udid: string, why: string | null): void => {
    const prev = refusedSince.get(udid)
    if (why === null) {
      if (prev) {
        log(
          `simview ${udid.slice(0, 8)} embedded after ${Math.round((Date.now() - prev.at) / 1000)}s (was: ${prev.why})`
        )
        refusedSince.delete(udid)
      }
      return
    }
    if (!prev) refusedSince.set(udid, { at: Date.now(), why })
    if (!prev || prev.why !== why) log(`simview ${udid.slice(0, 8)} not embedded: ${why}`)
    if (prev && prev.why !== why) prev.why = why
  }

  const detach = (udid: string): void => {
    const inflight = pending.get(udid)
    if (inflight) inflight.cancelled = true
    const a = attached.get(udid)
    if (!a) return
    attached.delete(udid)
    clearInterval(a.timer)
    try {
      getMod()?.detach(a.id)
    } catch {
      /* the window it lived in is gone */
    }
  }

  const detachAll = (): void => {
    for (const p of pending.values()) p.cancelled = true
    for (const udid of [...attached.keys()]) detach(udid)
  }

  const safeNativeDetach = (m: SimViewModule, id: number): void => {
    try {
      m.detach(id)
    } catch {
      /* already torn down */
    }
  }

  const attach = async (win: BrowserWindow, udid: string): Promise<AttachResult> => {
    const m = getMod()
    if (!m) {
      note(udid, 'simview is not available')
      return { ok: false, error: 'simview is not available' }
    }
    if (!m.attachAsync) {
      // Never fall back to synchronous attach() on Electron's main thread: a
      // wedged CoreSimulator XPC call would freeze the entire app forever.
      note(udid, 'simview module does not support async attach')
      return { ok: false, error: 'simview module does not support async attach' }
    }
    if (win.isDestroyed()) return { ok: false, error: 'no window' }

    // A previous attach for this exact simulator is still wedged inside
    // CoreSimulator: fail fast without spawning another thread or XPC call.
    if (pending.has(udid)) {
      note(udid, 'simulator display service timed out')
      return { ok: false, error: 'simulator display service timed out' }
    }

    // A remount for the same device (the pane re-rendered, a chat switch) takes
    // the view over rather than stacking a second one beside it.
    detach(udid)

    const entry: PendingAttach = { cancelled: false }
    pending.set(udid, entry)

    let nativePromise: Promise<SimViewAttachInfo>
    try {
      nativePromise = m.attachAsync({ view: win.getNativeWindowHandle(), udid })
    } catch (err) {
      if (pending.get(udid) === entry) pending.delete(udid)
      const why = String((err as Error)?.message ?? err)
      note(udid, why)
      return { ok: false, error: why }
    }

    // Always clean up the in-flight lock and any late attachment when the
    // native promise eventually settles — even long after a timeout or detach.
    const settled = nativePromise.then(
      (info) => {
        if (pending.get(udid) === entry) pending.delete(udid)
        if (entry.cancelled || win.isDestroyed()) {
          safeNativeDetach(m, info.id)
          return { ok: false as const, error: 'cancelled' }
        }
        return { ok: true as const, info }
      },
      (err) => {
        if (pending.get(udid) === entry) pending.delete(udid)
        const why = String((err as Error)?.message ?? err)
        return { ok: false as const, error: why }
      }
    )

    let timer: ReturnType<typeof setTimeout> | null = null
    const timedOut = new Promise<{ ok: false; error: string }>((resolve) => {
      timer = setTimeout(() => {
        entry.cancelled = true
        resolve({ ok: false, error: 'simulator display service timed out' })
      }, timeoutMs)
    })

    const outcome = await Promise.race([settled, timedOut])
    if (timer) clearTimeout(timer)

    if (!outcome.ok) {
      if (outcome.error !== 'cancelled') note(udid, outcome.error)
      return { ok: false, error: outcome.error }
    }

    const info = outcome.info
    const name = info.device
    // Follow the screen: a foldable switching screens changes its size, and
    // the pane maps taps by size. Also the only sign a device has gone.
    // Reads only from native memory (health()), never calls CoreSimulator on
    // Electron's main thread.
    let misses = 0
    const poll = setInterval(() => {
      const a = attached.get(udid)
      if (!a || win.isDestroyed()) return detach(udid)
      let h: { screens: number; width: number; height: number } | null = null
      try {
        h = m.health ? m.health(a.id) : null
      } catch {
        h = null
      }
      if (!h || h.screens <= 0) {
        // Two in a row, so a device mid-reboot of its display is not taken for gone.
        if (++misses >= 2) {
          detach(udid)
          if (!win.isDestroyed()) win.webContents.send(`sim:gone:${udid}`)
          onGone(udid)
        }
        return
      }
      misses = 0
      if (h.width && h.height && (h.width !== a.pxWidth || h.height !== a.pxHeight)) {
        a.pxWidth = h.width
        a.pxHeight = h.height
        const pt = toPoints(h.width, h.height, name)
        win.webContents.send(`sim:view-size:${udid}`, { width: pt.width, height: pt.height })
      }
    }, 1000)

    attached.set(udid, {
      id: info.id,
      win,
      pxWidth: info.width,
      pxHeight: info.height,
      timer: poll
    })
    win.once('closed', () => detach(udid))
    const pt = toPoints(info.width, info.height, name)
    note(udid, null)
    return { ok: true, width: pt.width, height: pt.height, screens: info.screens, device: name }
  }

  const setBounds = (
    udid: string,
    rect: { x: number; y: number; width: number; height: number },
    radius: number,
    rotation: number
  ): void => {
    const a = attached.get(udid)
    const m = getMod()
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

  const setVisible = (udid: string, on: boolean): void => {
    const a = attached.get(udid)
    if (!a) return
    try {
      getMod()?.setVisible(a.id, !!on)
    } catch {
      /* gone mid-update */
    }
  }

  return {
    isViewing: (udid) => attached.has(udid),
    attach,
    setBounds,
    setVisible,
    detach,
    detachAll
  }
}

let controller: SimViewController | null = null

export function isViewing(udid: string): boolean {
  return controller?.isViewing(udid) ?? false
}

export function detachAllSimViews(): void {
  controller?.detachAll()
}

export function registerSimViewIpc(toPoints: ToPoints, onGone: (udid: string) => void): void {
  const ctrl = createSimViewController({
    load,
    toPoints,
    onGone,
    log: healthLog
  })
  controller = ctrl

  ipcMain.handle('sim:view-attach', (e, udid: string) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return { ok: false, error: 'no window' }
    return ctrl.attach(win, udid)
  })

  ipcMain.on(
    'sim:view-bounds',
    (
      _e,
      udid: string,
      rect: { x: number; y: number; width: number; height: number },
      radius: number,
      rotation: number
    ) => ctrl.setBounds(udid, rect, radius, rotation)
  )

  ipcMain.on('sim:view-visible', (_e, udid: string, on: boolean) => ctrl.setVisible(udid, on))

  ipcMain.on('sim:view-detach', (_e, udid: string) => ctrl.detach(udid))
}
