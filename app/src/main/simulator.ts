import { ipcMain, BrowserWindow, nativeImage } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileSync, unlinkSync } from 'fs'

const run = promisify(execFile)

/**
 * The live simulator pane.
 *
 * The plan was baguette's framebuffer stream, and half of that tool delivers:
 * its input injection (tap/swipe/type/press) drives a booted device reliably.
 * The stream does not — measured against 0.1.88, `--format mjpeg` writes its
 * multipart HTTP header and then zero frames on iOS 18.6 and 26.5, headless or
 * with Simulator.app visible, and `--format h264` is rejected as an unknown
 * format despite being advertised in --help.
 *
 * So frames come from `simctl io screenshot`, which works everywhere and needs
 * nothing installed: ~1.6 fps at full resolution, which is a poor video and a
 * perfectly good mirror of an app you are building. Two things make it feel
 * live rather than laggy: frames are downscaled here (a 290 KB JPEG per tick
 * would cost more in IPC than in capture), and any input forces an immediate
 * grab, so the picture reacts to a tap in about the time the tap takes.
 */

export interface SimDevice {
  udid: string
  name: string
  state: string
  runtime: string
}

interface Stream {
  udid: string
  name: string
  timer: ReturnType<typeof setInterval>
  window: BrowserWindow
  busy: boolean
  /** Bumped on input so a grab that is already in flight can be discarded. */
  generation: number
}

const streams = new Map<string, Stream>()
/** Whether baguette is on PATH — decided once, since input needs it. */
let baguettePath: string | null | undefined

async function findBaguette(): Promise<string | null> {
  if (baguettePath !== undefined) return baguettePath
  for (const p of ['/opt/homebrew/bin/baguette', '/usr/local/bin/baguette']) {
    try {
      await run(p, ['--version'], { timeout: 4000 })
      baguettePath = p
      return p
    } catch {
      /* try the next one */
    }
  }
  baguettePath = null
  return null
}

export async function listDevices(): Promise<SimDevice[]> {
  try {
    const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024
    })
    const parsed = JSON.parse(stdout) as { devices: Record<string, SimDevice[]> }
    const out: SimDevice[] = []
    for (const [runtime, list] of Object.entries(parsed.devices)) {
      const label = runtime.replace('com.apple.CoreSimulator.SimRuntime.', '').replace(/-/g, ' ')
      for (const d of list) out.push({ ...d, runtime: label })
    }
    // Booted first, then by name — the one you want is nearly always running.
    return out.sort((a, b) =>
      a.state === b.state ? a.name.localeCompare(b.name) : a.state === 'Booted' ? -1 : 1
    )
  } catch {
    return []
  }
}

export async function bootDevice(udid: string): Promise<void> {
  await run('xcrun', ['simctl', 'boot', udid], { timeout: 90_000 }).catch((e) => {
    // Already booted is success, not failure.
    if (!/current state: Booted/i.test(String(e))) throw e
  })
  await run('xcrun', ['simctl', 'bootstatus', udid, '-b'], { timeout: 120_000 }).catch(() => {})
}

/**
 * Pixels → points. baguette's gestures are in POINTS (a tap at pixel
 * coordinates lands off-screen and silently does nothing — measured), and
 * neither simctl nor baguette will tell us the scale, so derive it: take the
 * first scale that divides both dimensions evenly and leaves a plausible screen.
 * iPhone 16 → 1179x2556 / 3 = 393x852; SE → 750x1334 / 2 = 375x667; iPads are
 * 2x, so try 2 first for those.
 */
function toPoints(
  pxW: number,
  pxH: number,
  name: string
): { width: number; height: number; scale: number } {
  const order = /ipad/i.test(name) ? [2, 3] : [3, 2]
  for (const scale of order) {
    if (pxW % scale === 0 && pxH % scale === 0) {
      const width = pxW / scale
      if (width >= 300 && width <= 1400) return { width, height: pxH / scale, scale }
    }
  }
  return { width: pxW, height: pxH, scale: 1 }
}

/** One frame, downscaled, as a data URL — or null if the device isn't ready. */
async function grabFrame(
  udid: string,
  name = ''
): Promise<{ url: string; width: number; height: number } | null> {
  const file = join(tmpdir(), `sa-sim-${udid.slice(0, 8)}.jpg`)
  try {
    await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', file], { timeout: 15_000 })
    const img = nativeImage.createFromBuffer(readFileSync(file))
    if (img.isEmpty()) return null
    const { width: pxW, height: pxH } = img.getSize()
    // Half-size is plenty for a pane and a quarter of the bytes over IPC.
    const small = img.resize({ width: Math.max(320, Math.round(pxW / 2)), quality: 'good' })
    // Report POINTS: the renderer maps a click into this space and hands it
    // straight to the injector, so there is one coordinate system, not three.
    const pt = toPoints(pxW, pxH, name)
    return { url: small.toDataURL(), width: pt.width, height: pt.height }
  } catch {
    return null
  } finally {
    try {
      unlinkSync(file)
    } catch {
      /* it may never have been written */
    }
  }
}

function startStream(window: BrowserWindow, udid: string, fps: number, name = ''): void {
  stopStream(udid)
  const stream: Stream = { udid, name, window, busy: false, generation: 0, timer: 0 as never }
  const tick = async (): Promise<void> => {
    if (stream.busy || window.isDestroyed()) return
    stream.busy = true
    const gen = stream.generation
    const frame = await grabFrame(udid, stream.name)
    stream.busy = false
    // A newer input landed while this grab was in flight — its frame is the one
    // worth showing, so drop this stale picture rather than flashing backwards.
    if (gen !== stream.generation || window.isDestroyed()) return
    if (frame) window.webContents.send(`sim:frame:${udid}`, frame)
  }
  stream.timer = setInterval(tick, Math.max(300, Math.round(1000 / fps)))
  streams.set(udid, stream)
  void tick()
}

function stopStream(udid: string): void {
  const s = streams.get(udid)
  if (!s) return
  clearInterval(s.timer)
  streams.delete(udid)
}

export function stopAllSimStreams(): void {
  for (const udid of [...streams.keys()]) stopStream(udid)
}

/** Force a fresh frame now — called right after input so the pane feels alive. */
function nudge(udid: string): void {
  const s = streams.get(udid)
  if (!s) return
  s.generation += 1
  s.busy = false
  const w = s.window
  void grabFrame(udid, s.name).then((frame) => {
    if (frame && !w.isDestroyed()) w.webContents.send(`sim:frame:${udid}`, frame)
  })
}

export function registerSimulatorIpc(): void {
  ipcMain.handle('sim:list', () => listDevices())
  ipcMain.handle('sim:boot', async (_e, udid: string) => {
    await bootDevice(udid)
    return true
  })
  ipcMain.handle('sim:shutdown', async (_e, udid: string) => {
    await run('xcrun', ['simctl', 'shutdown', udid], { timeout: 30_000 }).catch(() => {})
    stopStream(udid)
    return true
  })

  ipcMain.on('sim:stream-start', async (e, udid: string, fps = 2) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (!win) return
    const name = (await listDevices()).find((d) => d.udid === udid)?.name ?? ''
    startStream(win, udid, fps, name)
  })
  ipcMain.on('sim:stream-stop', (_e, udid: string) => stopStream(udid))

  /**
   * Input goes through baguette, whose gesture side works well. Coordinates
   * arrive in POINTS in the device's own space, which is what baguette wants —
   * the renderer converts from its rendered size before sending.
   */
  ipcMain.handle(
    'sim:input',
    async (
      _e,
      udid: string,
      action: { type: 'tap' | 'swipe' | 'press' | 'text'; [k: string]: unknown }
    ) => {
      const bin = await findBaguette()
      if (!bin) return { ok: false, error: 'baguette-not-installed' }
      const args: string[] = []
      if (action.type === 'tap') {
        args.push('tap', '--udid', udid, '--x', String(action.x), '--y', String(action.y),
          '--width', String(action.width), '--height', String(action.height))
      } else if (action.type === 'swipe') {
        args.push('swipe', '--udid', udid, '--start-x', String(action.x), '--start-y', String(action.y),
          '--end-x', String(action.toX), '--end-y', String(action.toY),
          '--width', String(action.width), '--height', String(action.height))
      } else if (action.type === 'press') {
        args.push('press', '--udid', udid, '--button', String(action.button))
      } else {
        args.push('type', '--udid', udid, '--text', String(action.text))
      }
      try {
        const { stdout } = await run(bin, args, { timeout: 20_000 })
        nudge(udid) // show the result of the tap immediately
        return { ok: true, out: stdout.trim().slice(0, 200) }
      } catch (err) {
        return { ok: false, error: String(err).slice(0, 200) }
      }
    }
  )

  ipcMain.handle('sim:has-input', async () => !!(await findBaguette()))
}
