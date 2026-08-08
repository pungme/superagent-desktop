import {
  app,
  ipcMain,
  BrowserWindow,
  nativeImage,
  systemPreferences,
  shell
} from 'electron'
import {
  execFile,
  spawn,
  ChildProcessWithoutNullStreams,
  ChildProcessByStdio
} from 'child_process'
import type { Readable } from 'stream'
import { promisify } from 'util'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFileSync, unlinkSync, existsSync } from 'fs'
import { createHash } from 'crypto'

const run = promisify(execFile)

/**
 * The simulator pane's main-process half: frames, gestures, and the Simulator
 * window itself.
 *
 * Reading the simulator's framebuffer directly would be the obvious way to get
 * a live picture, and every tool that does it through Apple's private
 * frameworks is broken on Xcode 26 — baguette and idb both mount the surface,
 * announce success, and then emit nothing. The README's maintainer note has
 * the measurements. So there are two honest sources instead:
 *
 *   - `sim:capture-*` prepares the Simulator's own window to be captured by the
 *     renderer, which is what the live view plays. Costs a Screen Recording
 *     grant, and gives the frame rate the device actually renders at.
 *   - `grabFrame` shells out to `simctl io screenshot`, which needs no
 *     permission at all and costs ~530ms a frame — a poor video and a perfectly
 *     good mirror of an app you are building. Frames are downscaled here (a
 *     290 KB JPEG per tick would cost more in IPC than in capture) and any
 *     input forces an immediate grab, so the picture reacts to a tap in about
 *     the time the tap takes.
 *
 * Gestures go through baguette either way; see `inputSession`.
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
  timer: ReturnType<typeof setTimeout> | null
  window: BrowserWindow
  busy: boolean
  stopped: boolean
  /** Bumped on input so a grab that is already in flight can be discarded. */
  generation: number
  /** Poll fast until this moment — set whenever the user touches the device. */
  activeUntil: number
  /** Digest of the last frame sent, so a still screen costs nothing. */
  lastHash: string
  /** Consecutive failures; the device is probably shutting down. */
  misses: number
}

const streams = new Map<string, Stream>()
/** "Stay On Top" is a toggle we can set but not read — so set it only once. */
let pinnedOnce = false

/**
 * A long-lived `baguette input` per device. Spawning a process per gesture cost
 * 200-400ms before anything reached the device, which is most of why tapping
 * the mirror felt like poking something underwater. This session stays open and
 * takes newline-delimited JSON, so a tap is a write to a pipe.
 *
 * It only understands tap, swipe and key (press and text come back as "unknown
 * kind"), so those two still go through a one-shot command — they are not the
 * ones you fire in quick succession.
 */
interface InputSession {
  proc: ChildProcessWithoutNullStreams
  pending: ((res: { ok: boolean; error?: string }) => void)[]
}
const inputSessions = new Map<string, InputSession>()
const SESSION_KINDS = new Set(['tap', 'swipe', 'key'])

async function inputSession(udid: string): Promise<InputSession | null> {
  const existing = inputSessions.get(udid)
  if (existing && !existing.proc.killed && existing.proc.exitCode === null) return existing
  const bin = await findBaguette()
  if (!bin) return null
  const proc = spawn(bin, ['input', '--udid', udid], { stdio: ['pipe', 'pipe', 'pipe'] })
  const session: InputSession = { proc, pending: [] }
  let buf = ''
  proc.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString()
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('{')) continue
      const done = session.pending.shift()
      if (!done) continue
      try {
        done(JSON.parse(line) as { ok: boolean; error?: string })
      } catch {
        done({ ok: false, error: 'bad-ack' })
      }
    }
  })
  const die = (): void => {
    inputSessions.delete(udid)
    for (const p of session.pending.splice(0)) p({ ok: false, error: 'session-ended' })
  }
  proc.on('exit', die)
  proc.on('error', die)
  inputSessions.set(udid, session)
  return session
}

function endInputSession(udid: string): void {
  const s = inputSessions.get(udid)
  if (!s) return
  inputSessions.delete(udid)
  try {
    s.proc.stdin.end()
    s.proc.kill()
  } catch {
    /* already gone */
  }
}

export function stopAllSimInput(): void {
  for (const udid of [...inputSessions.keys()]) endInputSession(udid)
}

function sendGesture(
  session: InputSession,
  payload: Record<string, unknown>
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    // A gesture that never gets acked must not wedge the queue behind it.
    const timer = setTimeout(() => {
      const i = session.pending.indexOf(done)
      if (i >= 0) session.pending.splice(i, 1)
      resolve({ ok: false, error: 'timeout' })
    }, 5000)
    const done = (res: { ok: boolean; error?: string }): void => {
      clearTimeout(timer)
      resolve(res)
    }
    session.pending.push(done)
    session.proc.stdin.write(JSON.stringify(payload) + '\n')
  })
}
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
): Promise<{ url: string; width: number; height: number; hash: string } | null> {
  const file = join(tmpdir(), `sa-sim-${udid.slice(0, 8)}.jpg`)
  try {
    await run('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=jpeg', file], { timeout: 15_000 })
    const img = nativeImage.createFromBuffer(readFileSync(file))
    if (img.isEmpty()) return null
    const { width: pxW, height: pxH } = img.getSize()
    // Half-size is plenty for a pane and a quarter of the pixels.
    const small = img.resize({ width: Math.max(320, Math.round(pxW / 2)), quality: 'good' })
    // JPEG, not toDataURL(): that returns PNG, which for a phone screenshot is
    // ~600 KB — encoded on the main thread and pushed over IPC twice a second.
    // The same frame as JPEG is around a tenth of that and encodes far faster.
    const buf = small.toJPEG(72)
    const pt = toPoints(pxW, pxH, name)
    return {
      url: `data:image/jpeg;base64,${buf.toString('base64')}`,
      width: pt.width,
      height: pt.height,
      hash: createHash('md5').update(buf).digest('hex')
    }
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

/**
 * Poll the device for frames. Self-scheduling rather than a fixed interval so
 * the rate can follow what the user is doing: quick while they are touching the
 * screen, lazy when they are only watching. A grab takes ~600ms, so this is the
 * ceiling either way — the point is not to spend it when nothing is happening.
 */
const FAST_MS = 250
const IDLE_MS = 900
const ACTIVE_WINDOW_MS = 4000

/**
 * The native framebuffer stream.
 *
 * `native/simfb` reads the device's IOSurface straight out of CoreSimulator —
 * the same surface Simulator.app draws — and writes JPEG frames on a damage
 * callback. That is roughly 20fps while something is moving against the
 * screenshot mirror's hard ~2fps ceiling, it needs no Screen Recording grant,
 * and it doesn't care whether Simulator.app is running.
 *
 * It leans on private API, so treat it as best-effort: if the helper is
 * missing, won't start, or dies, `startStream` falls back to the mirror.
 */
const nativeStreams = new Map<string, ChildProcessByStdio<null, Readable, Readable>>()

function simfbPath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'simfb')]
    : [join(__dirname, '../../native/simfb'), join(process.cwd(), 'native/simfb')]
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

/** @returns true if the native stream took over; false to use the mirror. */
function startNativeStream(window: BrowserWindow, udid: string, name: string): boolean {
  const bin = simfbPath()
  if (!bin) return false
  // Flipping modes quickly used to leave a helper per flip, all decoding the
  // same device — only ever one stream of either kind per device.
  stopNativeStream(udid)
  stopStream(udid)
  let proc: ChildProcessByStdio<null, Readable, Readable>
  try {
    proc = spawn(bin, ['--udid', udid, '--scale', '0.5', '--quality', '0.6', '--fps', '30'], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
  } catch {
    return false
  }

  let buf = Buffer.alloc(0)
  let header: { width: number; height: number } | null = null
  let sawFrame = false

  proc.stdout.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk])
    if (!header) {
      const nl = buf.indexOf(0x0a)
      if (nl < 0) return
      try {
        header = JSON.parse(buf.subarray(0, nl).toString()) as { width: number; height: number }
      } catch {
        return
      }
      buf = buf.subarray(nl + 1)
    }
    // 4-byte big-endian length, then that many JPEG bytes.
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0)
      if (buf.length < 4 + n) break
      const jpeg = buf.subarray(4, 4 + n)
      buf = buf.subarray(4 + n)
      if (window.isDestroyed()) return
      sawFrame = true
      const pt = toPoints(header!.width, header!.height, name)
      window.webContents.send(`sim:frame:${udid}`, {
        url: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
        width: pt.width,
        height: pt.height
      })
    }
  })

  let stderr = ''
  proc.stderr.on('data', (c: Buffer) => {
    stderr += c.toString()
  })

  const done = (): void => {
    nativeStreams.delete(udid)
    if (sawFrame || window.isDestroyed()) return
    // Never produced a frame — the private API probably moved. Say why once,
    // then fall back so the pane still shows something.
    console.error('[simfb] no frames:', stderr.trim() || 'exited silently')
    if (!streams.has(udid)) startStream(window, udid, 2, name)
  }
  proc.on('exit', done)
  proc.on('error', done)

  nativeStreams.set(udid, proc)
  return true
}

function stopNativeStream(udid: string): void {
  const p = nativeStreams.get(udid)
  if (!p) return
  nativeStreams.delete(udid)
  try {
    p.kill()
  } catch {
    /* already gone */
  }
}

export function stopAllNativeStreams(): void {
  for (const udid of [...nativeStreams.keys()]) stopNativeStream(udid)
}

function startStream(window: BrowserWindow, udid: string, _fps: number, name = ''): void {
  stopStream(udid)
  stopNativeStream(udid)
  const stream: Stream = {
    udid,
    name,
    window,
    busy: false,
    stopped: false,
    generation: 0,
    timer: null,
    activeUntil: Date.now() + ACTIVE_WINDOW_MS,
    lastHash: '',
    misses: 0
  }
  const tick = async (): Promise<void> => {
    if (stream.stopped || window.isDestroyed()) return
    stream.busy = true
    const gen = stream.generation
    const frame = await grabFrame(udid, stream.name)
    stream.busy = false
    if (stream.stopped || window.isDestroyed()) return
    if (!frame) {
      // A few failures in a row means the device went away — say so once
      // rather than silently freezing on the last picture.
      stream.misses += 1
      if (stream.misses === 3) window.webContents.send(`sim:gone:${udid}`)
    } else {
      stream.misses = 0
      // A newer input landed while this grab was in flight, or the screen has
      // not changed: either way this picture is not worth an IPC round trip.
      if (gen === stream.generation && frame.hash !== stream.lastHash) {
        stream.lastHash = frame.hash
        window.webContents.send(`sim:frame:${udid}`, frame)
      }
    }
    if (stream.stopped) return
    const fast = Date.now() < stream.activeUntil
    stream.timer = setTimeout(tick, fast ? FAST_MS : IDLE_MS)
  }
  streams.set(udid, stream)
  void tick()
}

function stopStream(udid: string): void {
  const s = streams.get(udid)
  if (!s) return
  s.stopped = true
  if (s.timer) clearTimeout(s.timer)
  streams.delete(udid)
}

export function stopAllSimStreams(): void {
  stopAllNativeStreams()
  for (const udid of [...streams.keys()]) stopStream(udid)
}

/** Force a fresh frame now — called right after input so the pane feels alive. */
function nudge(udid: string): void {
  const s = streams.get(udid)
  if (!s) return
  s.generation += 1
  s.activeUntil = Date.now() + ACTIVE_WINDOW_MS
  const w = s.window
  void grabFrame(udid, s.name).then((frame) => {
    if (!frame || w.isDestroyed() || s.stopped) return
    s.lastHash = frame.hash
    w.webContents.send(`sim:frame:${udid}`, frame)
  })
}

/**
 * "Attach" mode: instead of mirroring frames, put Apple's own Simulator window
 * exactly over the pane. Nothing is streamed, so it runs at native speed with
 * real touch and keyboard — the honest answer to "can't we just put the
 * simulator in there?".
 *
 * macOS has no supported way to reparent another application's window into
 * ours, so this is the closest legitimate thing: move and size the real window
 * to the pane's rectangle and keep it there. It needs Accessibility permission
 * (the same grant window managers ask for), and the window floats above ours
 * rather than being clipped by it — so the pane hides it when it scrolls away
 * or the app goes to the back.
 */
async function osa(script: string): Promise<string> {
  const { stdout } = await run('osascript', ['-e', script], { timeout: 8000 })
  return stdout.trim()
}

async function moveSimulatorWindow(rect: {
  x: number
  y: number
  width: number
  height: number
}): Promise<{ ok: boolean; error?: string }> {
  // Three steps, not one script: the window keeps the device's aspect ratio, so
  // asking for a box gives back a different one, and reading that back inside
  // the same script returns the size we asked for rather than the size it took
  // (measured — the device then sat hard against the left edge instead of
  // centred). Set, read, then place using what it actually became.
  const win = 'tell application "System Events" to tell process "Simulator" to'
  try {
    const exists = await osa(
      'tell application "System Events" to if exists process "Simulator" then return "y"'
    )
    if (exists !== 'y') return { ok: false, error: 'no-process' }
    await osa(`${win} set size of window 1 to {${Math.round(rect.width)}, ${Math.round(rect.height)}}`)
    // The resize settles a beat after the call returns; reading immediately
    // gives back the size we asked for rather than the one it took.
    await new Promise((r) => setTimeout(r, 250))
    const got = await osa(`${win} get size of window 1`)
    const [w, h] = got.split(',').map((n) => Number(n.trim()))
    const x = Math.round(rect.x + (rect.width - (w || rect.width)) / 2)
    const y = Math.round(rect.y + (rect.height - (h || rect.height)) / 2)
    await osa(`${win} set position of window 1 to {${x}, ${y}}`)
    return { ok: true }
  } catch (err) {
    const msg = String(err)
    // -1719 is the permission refusal; everything else is a real failure.
    if (/1719/.test(msg)) return { ok: false, error: 'no-accessibility' }
    if (/window 1/.test(msg)) return { ok: false, error: 'no-window' }
    return { ok: false, error: msg.slice(0, 160) }
  }
}

export function registerSimulatorIpc(): void {
  ipcMain.handle('sim:attach-ready', () => ({
    trusted: systemPreferences.isTrustedAccessibilityClient(false)
  }))
  ipcMain.handle('sim:attach-request', () => ({
    // Passing true makes macOS show its own "grant access" dialog once.
    trusted: systemPreferences.isTrustedAccessibilityClient(true)
  }))
  ipcMain.handle('sim:attach-settings', () => {
    void shell.openExternal(
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'
    )
    return true
  })
  ipcMain.handle(
    'sim:attach',
    async (_e, udid: string, rect: { x: number; y: number; width: number; height: number }) => {
      // Bring up Apple's Simulator showing this device, then park its window.
      await run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid], {
        timeout: 20_000
      }).catch(() => {})
      // Once per run: the menu item doesn't expose its checked state through
      // accessibility (it always reads `missing value`), so clicking it on
      // every attach would toggle it back off half the time.
      if (!pinnedOnce) {
        pinnedOnce = true
      // Two Simulator settings make an attached window behave: "Stay On Top"
      // (otherwise clicking back into SuperAgent to type sends the device
      // behind our window and the pane looks empty) and bezels off.
      await run('osascript', [
        '-e',
        `tell application "System Events" to tell process "Simulator"
           try
             set mi to menu item "Stay On Top" of menu 1 of menu bar item "Window" of menu bar 1
             set mark to value of attribute "AXMenuItemMarkChar" of mi
             if mark is missing value or mark is "" then click mi
           end try
         end tell`
      ]).catch(() => {})
      }
      // Device bezels carry a large minimum window size — with them on, the
      // window refuses to shrink into a pane (measured: 972px tall against a
      // 682px pane). Off, the same window fits happily, and the pane's own
      // frame reads better than a second one inside it.
      await run('osascript', [
        '-e',
        `tell application "System Events" to tell process "Simulator"
           try
             set mi to menu item "Show Device Bezels" of menu 1 of menu bar item "Window" of menu bar 1
             set mark to value of attribute "AXMenuItemMarkChar" of mi
             if mark is not missing value and mark is not "" then click mi
           end try
         end tell`
      ]).catch(() => {})
      // The window needs a moment to exist before it can be positioned.
      for (let i = 0; i < 12; i++) {
        const res = await moveSimulatorWindow(rect)
        if (res.ok) return res
        if (res.error === 'no-accessibility') return res
        await new Promise((r) => setTimeout(r, 700))
      }
      return { ok: false, error: 'window-never-appeared' }
    }
  )
  ipcMain.handle('sim:attach-move', (_e, rect) => moveSimulatorWindow(rect))
  ipcMain.handle('sim:attach-hide', async () => {
    // Hiding beats un-pinning: a window told to stay on top would otherwise
    // float over whatever the user switches to.
    await run('osascript', [
      '-e',
      'tell application "System Events" to set visible of process "Simulator" to false'
    ]).catch(() => {})
    return true
  })
  ipcMain.handle('sim:attach-show', async () => {
    await run('osascript', [
      '-e',
      'tell application "System Events" to set visible of process "Simulator" to true'
    ]).catch(() => {})
    return true
  })

  /**
   * The live view's frame source: Chromium's own window capture, which is
   * ScreenCaptureKit underneath on this macOS. It keeps producing frames for a
   * window that is behind ours or off-screen, which is the whole trick — the
   * Simulator window can sit out of the way while its pixels play inside the
   * pane. Returns the source id the renderer feeds to getUserMedia.
   */
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
    // Native framebuffer first; the screenshot mirror is the fallback.
    if (startNativeStream(win, udid, name)) return
    startStream(win, udid, fps, name)
  })
  ipcMain.on('sim:stream-stop', (_e, udid: string) => {
    stopNativeStream(udid)
    stopStream(udid)
    endInputSession(udid)
  })

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
      action: { type: 'tap' | 'swipe' | 'press' | 'text' | 'key'; [k: string]: unknown }
    ) => {
      const bin = await findBaguette()
      if (!bin) return { ok: false, error: 'baguette-not-installed' }

      // Fast path: tap/swipe/key go down the open session — no process to
      // start, so the device feels the gesture almost immediately.
      if (SESSION_KINDS.has(action.type)) {
        const session = await inputSession(udid)
        if (session) {
          const payload: Record<string, unknown> =
            action.type === 'swipe'
              ? {
                  type: 'swipe',
                  startX: action.x,
                  startY: action.y,
                  endX: action.toX,
                  endY: action.toY,
                  width: action.width,
                  height: action.height
                }
              : action.type === 'key'
                ? { type: 'key', code: action.code, ...(action.modifiers ? { modifiers: action.modifiers } : {}) }
                : {
                    type: 'tap',
                    x: action.x,
                    y: action.y,
                    width: action.width,
                    height: action.height,
                    ...(action.duration ? { duration: action.duration } : {})
                  }
          const res = await sendGesture(session, payload)
          if (res.ok) {
            nudge(udid)
            return { ok: true }
          }
          // Session refused it — fall through to the one-shot command rather
          // than dropping the gesture.
        }
      }

      const args: string[] = []
      if (action.type === 'key') {
        args.push('key', '--udid', udid, '--code', String(action.code))
        if (action.modifiers) args.push('--modifiers', String(action.modifiers))
      } else if (action.type === 'tap') {
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
