import { randomInt } from 'crypto'
import {
  BrowserWindow,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  powerMonitor,
  screen
} from 'electron'
import { z } from 'zod'
import {
  addStopListener,
  appUnder,
  captureDisplayBitmap,
  computerStatus,
  deniedApps,
  frontApp,
  holdStopKeyFor,
  killRunningHelper,
  ownWindows,
  releaseStopKeyFor,
  runHelper,
  windowLayout
} from '../computer-use'
import { settingGet, settingSet } from '../computer-settings'
import { healthLog } from '../health'
import { broadcastToWindows } from '../util'
import { listDevices } from '../companion/devices'
import type { LaidWindow, AppRef } from '../../shared/computer-use'
import type { RpcErrorCode, ServerFrame, WireRemote } from '../../shared/companion-protocol'
import { RemoteControl, RemoteRefusal, type DisplayInfo, type RemoteDeps } from './control'
import { askAllowDialog, createBanner, showCodeDialog } from './banner'
import { bannerHidden, clipboardConcealed } from '../../shared/remote-control'
import { registerSwitchIpc } from './guarded-ipc'
import { trustedSender } from './switches'
import { remoteCodeParams, remoteInputParams, remoteViewParams } from './input'
import type { Bitmap, Encode, Rect } from './stream'

/**
 * Remote control, wired to this Mac: the real dependencies of control.ts, the
 * Settings switch, the phone's RPC methods and the Mac's own events (sleep,
 * lock, ⌥Esc). The rules live in control.ts; this file only connects it.
 */

const KEY = 'remote.enabled'

/**
 * Read from the store once, then held here and changed only through IPC, as
 * computer.enabled is: the store's file is writable by an agent's shell, and
 * switching this on must take someone at the Mac, in Settings.
 */
let enabledNow: boolean | null = null

function readEnabled(): boolean {
  if (enabledNow === null) {
    const v = settingGet(KEY)
    // undefined: not knowable yet. Off, and asked again next time.
    if (v === undefined) return false
    enabledNow = v === '1'
  }
  return process.platform === 'darwin' && enabledNow
}

/** What carries frames to and from a phone, bound by the companion once it is up. */
export interface RemoteTransport {
  send: (connId: string, frame: ServerFrame) => void
  pushAll: (wire: (connId: string) => WireRemote) => void
  alive: (connId: string) => boolean
  backlog: () => number
}

let transport: RemoteTransport = {
  send: () => undefined,
  pushAll: () => undefined,
  alive: () => false,
  backlog: () => 0
}

export function bindRemoteTransport(t: RemoteTransport): void {
  transport = t
}

/** Why remote control cannot run on this Mac right now, or null. */
export function remoteNotReady(): string | null {
  const s = computerStatus()
  if (!s.supported) return 'Remote control needs a Mac.'
  if (!s.helper) return 'The helper that moves the pointer is missing from this build.'
  const missing = [
    s.screen ? null : 'Screen Recording (to show the screen)',
    s.accessibility ? null : 'Accessibility (to move the pointer and type)'
  ].filter(Boolean)
  return missing.length
    ? `Superagent does not have ${missing.join(' or ')} yet. Allow it in System Settings → Privacy & Security on the Mac.`
    : null
}

const displaysNow = (): DisplayInfo[] =>
  screen.getAllDisplays().map((d, i) => ({
    id: d.id,
    name: d.label || (i === 0 ? 'Main display' : `Display ${i + 1}`),
    bounds: d.bounds
  }))

const inside = (r: Electron.Rectangle, x: number, y: number): boolean =>
  x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height

/** Pictures turned into JPEG: one NativeImage per picture, cropped for each frame. */
const images = new WeakMap<Uint8Array, Electron.NativeImage>()
const encode: Encode = (picture: Bitmap, rect: Rect, quality: number) => {
  let img = images.get(picture.data)
  if (!img) {
    img = nativeImage.createFromBitmap(
      Buffer.from(picture.data.buffer, picture.data.byteOffset, picture.data.byteLength),
      { width: picture.width, height: picture.height }
    )
    images.set(picture.data, img)
  }
  const whole = rect.w === picture.width && rect.h === picture.height
  return (whole ? img : img.crop({ x: rect.x, y: rect.y, width: rect.w, height: rect.h })).toJPEG(
    quality
  )
}

function realDeps(): RemoteDeps {
  const own = ownWindows()
  const banner = createBanner(() => control().end('stopped-at-mac'))
  return {
    now: () => Date.now(),
    below: (n) => randomInt(n),
    send: (c, f) => transport.send(c, f),
    pushAll: (w) => transport.pushAll(w),
    alive: (c) => transport.alive(c),
    backlog: () => transport.backlog(),
    askAllow: askAllowDialog,
    showCode: showCodeDialog,
    displays: displaysNow,
    notReady: remoteNotReady,
    front: frontApp,
    layout: windowLayout,
    appAt: appUnder,
    clipboardConcealed: () => clipboardConcealed(clipboard),
    bannerHidden,
    ownSurfaceAt: (x, y) => {
      if (own.surfaceAt(x, y)) return true
      if (banner.bounds().some((b) => inside(b, x, y))) return true
      // Any window of Superagent's own that is on screen there.
      return BrowserWindow.getAllWindows().some(
        (w) => !w.isDestroyed() && w.isVisible() && inside(w.getBounds(), x, y)
      )
    },
    ownFocused: own.focused,
    ownShortcuts: own.shortcuts,
    denied: deniedApps,
    run: async (args) => {
      const r = await runHelper(args)
      return { ok: r.ok, error: r.error }
    },
    killRunning: killRunningHelper,
    cursor: () => {
      try {
        return screen.getCursorScreenPoint()
      } catch {
        return null
      }
    },
    capture: async (display, width) => {
      const d = screen.getAllDisplays().find((x) => x.id === display.id)
      if (!d) throw new Error('The display is gone.')
      return captureDisplayBitmap(d, width)
    },
    encode,
    banner,
    stopKey: {
      hold: () => {
        holdStopKeyFor('remote')
        return !computerStatus().stopKeyRefused
      },
      release: () => releaseStopKeyFor('remote')
    },
    log: healthLog,
    changed: () => broadcastToWindows('remote:changed', status())
  }
}

let instance: RemoteControl | null = null
let deps: RemoteDeps | null = null

function control(): RemoteControl {
  if (!instance) {
    // A test run (never a packaged app, which also has the variable stripped).
    const testRun = !app.isPackaged && !!process.env.COVE_USER_DATA
    deps = testRun ? inertDeps(realDeps()) : realDeps()
    instance = new RemoteControl(deps)
    if (testRun) confirmSwitch = async () => true
    if (testRun) (globalThis as Record<string, unknown>).__remoteTest = testHandle(instance, deps)
  }
  return instance
}

/** Whether the Mac advertises Remote control to phones: switched on, here. */
export function remoteControlOn(): boolean {
  return control().isEnabled()
}

export function remoteWire(connId: string | null): WireRemote {
  return control().wire(connId)
}

export function status(): {
  supported: boolean
  enabled: boolean
  active: boolean
  asking: boolean
  device: string
  since: number
  shells: boolean
  paused: string | null
  note: string
} {
  const c = control()
  return {
    supported: process.platform === 'darwin',
    ...c.summary(),
    note: remoteNotReady() ?? ''
  }
}

/** Start it: read the switch, listen for the Mac's own events. Once the app is ready. */
export function startRemoteControl(): void {
  const c = control()
  c.setEnabled(readEnabled())
  // ⌥Esc, from whatever app is in front.
  addStopListener(() => c.end('hotkey'))
  powerMonitor.on('suspend', () => c.end('slept'))
  powerMonitor.on('lock-screen', () => c.end('locked'))
  // Fast user switching: another person's desktop is not the phone's to use.
  powerMonitor.on('user-did-resign-active', () => c.end('locked'))
  powerMonitor.on('shutdown', () => c.end('slept'))
}

/**
 * The question at the Mac before a switch goes on: a native dialog, Cancel the
 * default. A test run answers yes (nothing there to click).
 */
let confirmSwitch = async (what: 'on' | 'shells'): Promise<boolean> => {
  const r = await dialog.showMessageBox({
    type: 'warning',
    title: 'Superagent',
    message:
      what === 'on'
        ? 'Let your paired phone control this Mac?'
        : 'Allow terminals and scripting apps for phones?',
    detail:
      what === 'on'
        ? 'It stays on, even after a restart, until you switch it off here. Each time a phone asks, this Mac asks you again.'
        : 'A phone that is allowed in can then run commands as you. This is off again whenever Superagent starts.',
    buttons: ['Cancel', what === 'on' ? 'Turn on' : 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true
  })
  return r.response === 1
}

/** Whether this IPC call comes from the app's main window, top frame (never the dot, never a sub-frame). */
export function fromMainWindow(
  e: Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>,
  isDot: (w: BrowserWindow | null) => boolean
): boolean {
  const win = BrowserWindow.fromWebContents(e.sender)
  return trustedSender(e, win, isDot(win))
}

/** `isDot`: whether a window is the dot's, which never flips a switch (passed in, so this file does not load the dot). */
export function registerRemoteControlIpc(isDot: (w: BrowserWindow | null) => boolean): void {
  ipcMain.handle('remote:status', () => status())
  registerSwitchIpc(ipcMain, (e: Electron.IpcMainInvokeEvent) => fromMainWindow(e, isDot), {
    confirm: (what) => confirmSwitch(what),
    isEnabled: () => control().isEnabled(),
    setEnabled: (v) => {
      settingSet(KEY, v ? '1' : '0')
      healthLog(`remote: switched ${v ? 'on' : 'off'} at the Mac`)
      // Off takes the shells setting with it (control.ts).
      control().setEnabled(v && process.platform === 'darwin')
    },
    setShells: (v) => {
      healthLog(`remote: shells and scripting apps ${v ? 'allowed' : 'not allowed'} at the Mac`)
      control().setShells(v)
    },
    status
  })
  ipcMain.handle('remote:stop', () => {
    control().end('stopped-at-mac')
    return status()
  })
}

// --- the phone's methods -----------------------------------------------------

export type RemoteRpcResult =
  { ok: true; result?: unknown } | { ok: false; error: { code: RpcErrorCode; message: string } }

const fail = (code: RpcErrorCode, message: string): RemoteRpcResult => ({
  ok: false,
  error: { code, message }
})

/** The phone's frames, from the conversation that wrote them. */
export interface RemoteCaller {
  connId: string
  deviceId: string
}

/**
 * `remote.*`, from an authenticated, paired phone (session.ts answers nothing
 * before hello and passes the connection and device that wrote). Nothing here
 * can allow a session: the only way past the Mac's dialog is a click on it.
 */
export async function handleRemoteRpc(
  who: RemoteCaller,
  method: string,
  params: unknown
): Promise<RemoteRpcResult> {
  const c = control()
  try {
    switch (method) {
      case 'remote.request': {
        const name = listDevices().find((d) => d.id === who.deviceId)?.name ?? 'Your phone'
        return {
          ok: true,
          result: c.request({ connId: who.connId, deviceId: who.deviceId, deviceName: name })
        }
      }
      case 'remote.code': {
        const p = remoteCodeParams.safeParse(params)
        if (!p.success) return fail('bad-params', 'six digits')
        return { ok: true, result: c.code(who, p.data.code) }
      }
      case 'remote.input': {
        const p = remoteInputParams.safeParse(params)
        if (!p.success) return fail('bad-params', p.error.message.slice(0, 300))
        return { ok: true, result: await c.input(who, p.data.actions) }
      }
      case 'remote.view': {
        const p = remoteViewParams.safeParse(params ?? {})
        if (!p.success) return fail('bad-params', p.error.message.slice(0, 300))
        c.view(who, p.data)
        return { ok: true, result: c.wire(who.connId) }
      }
      case 'remote.end':
        c.endFromPhone(who)
        return { ok: true, result: c.wire(who.connId) }
      default:
        return fail('bad-params', `unknown method ${method}`)
    }
  } catch (e) {
    if (e instanceof RemoteRefusal)
      return fail(e.reason === 'wrong-code' ? 'bad-params' : 'unavailable', e.message)
    if (e instanceof z.ZodError) return fail('bad-params', 'bad parameters')
    return fail('internal', (e as Error).message.slice(0, 200))
  }
}

/** The phone said something (any frame): it is still there. */
export function remoteHeard(connId: string): void {
  if (instance) instance.heard(connId)
}

/** A phone's connection went. */
export function remoteConnGone(connId: string): void {
  if (instance) instance.connGone(connId)
}

// --- test runs ---------------------------------------------------------------

/**
 * A test run never touches the screen, the mouse or the keyboard: the helper is
 * a recorder, the screen is a drawing, the dialogs are answered by the test, the
 * banner is a flag. Used whenever COVE_USER_DATA is set (every test run sets
 * it; the app never does), whatever the test remembers to replace.
 */
interface TestWorld {
  calls: string[][]
  front: AppRef | null
  under: AppRef | null
  windows: LaidWindow[]
  ownFocused: boolean
  ownSurface: boolean
  clipboardSecret: boolean
  bannerUp: boolean
  bannerShown: number
  stopKeyHeld: boolean
  stopKeyWorks: boolean
  alive: boolean
  ready: string | null
  displays: DisplayInfo[]
  asks: ((a: { allow: false } | { allow: true; displayId: number }) => void)[]
  codes: string[]
  codeClosed: (() => void)[]
  frames: ServerFrame[]
  logs: string[]
  tick: number
  cursor: { x: number; y: number } | null
}

function inertDeps(real: RemoteDeps): RemoteDeps {
  const w: TestWorld = {
    calls: [],
    front: { id: 'com.test.notes', name: 'Notes' },
    under: null,
    windows: [
      {
        app: { id: 'com.test.notes', name: 'Notes' },
        owner: 'Notes',
        layer: 0,
        frame: { x: 0, y: 0, width: 1440, height: 900 }
      }
    ],
    ownFocused: false,
    ownSurface: false,
    clipboardSecret: false,
    bannerUp: false,
    bannerShown: 0,
    stopKeyHeld: false,
    stopKeyWorks: true,
    alive: true,
    ready: null,
    displays: [{ id: 1, name: 'Test display', bounds: { x: 0, y: 0, width: 1440, height: 900 } }],
    asks: [],
    codes: [],
    codeClosed: [],
    frames: [],
    logs: [],
    tick: 0,
    cursor: { x: 10, y: 10 }
  }
  ;(globalThis as Record<string, unknown>).__remoteWorld = w
  return {
    ...real,
    send: (c, f) => {
      w.frames.push(f)
      if (w.frames.length > 200) w.frames.shift()
      transport.send(c, f)
    },
    alive: (c) => w.alive && transport.alive(c),
    backlog: () => 0,
    askAllow: ({ signal }) =>
      new Promise((resolve) => {
        w.asks.push(resolve)
        signal.addEventListener('abort', () => resolve({ allow: false }), { once: true })
      }),
    showCode: ({ code, signal }) =>
      new Promise<void>((resolve) => {
        w.codes.push(code)
        const done = (): void => resolve()
        w.codeClosed.push(done)
        signal.addEventListener('abort', done, { once: true })
      }),
    displays: () => w.displays,
    notReady: () => w.ready,
    front: async () => w.front,
    layout: async () => w.windows,
    appAt: async () => w.under,
    ownSurfaceAt: () => w.ownSurface,
    ownFocused: () => w.ownFocused,
    run: async (args) => {
      w.calls.push(args)
      return { ok: true, error: '' }
    },
    bannerHidden: () => false,
    killRunning: () => 0,
    clipboardConcealed: () => w.clipboardSecret,
    cursor: () => w.cursor,
    capture: async () => {
      // A drawing, not the screen: a box that moves a little each look.
      const width = 640
      const height = 400
      const data = new Uint8Array(width * height * 4)
      w.tick++
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const i = (y * width + x) * 4
          const inBox =
            x > 40 + (w.tick % 30) * 8 && x < 120 + (w.tick % 30) * 8 && y > 60 && y < 140
          data[i] = inBox ? 40 : 200
          data[i + 1] = inBox ? 40 : 190 + (y % 20)
          data[i + 2] = inBox ? 220 : 180 + (x % 24)
          data[i + 3] = 255
        }
      return { width, height, data }
    },
    banner: {
      show: () => {
        w.bannerUp = true
        w.bannerShown++
        return true
      },
      hide: () => {
        w.bannerUp = false
      },
      ok: () => w.bannerUp
    },
    stopKey: {
      hold: () => {
        w.stopKeyHeld = true
        return w.stopKeyWorks
      },
      release: () => {
        w.stopKeyHeld = false
      }
    },
    log: (line) => {
      w.logs.push(line)
      healthLog(line)
    }
  }
}

function testHandle(c: RemoteControl, d: RemoteDeps): Record<string, unknown> {
  const w = (globalThis as Record<string, unknown>).__remoteWorld as TestWorld
  return {
    world: w,
    control: c,
    deps: d,
    /** The Mac's person clicks Allow (or Don't allow) in the first dialog. */
    answerAsk: (allow: boolean) => {
      const r = w.asks.shift()
      r?.(allow ? { allow: true, displayId: w.displays[0].id } : { allow: false })
    },
    lastCode: () => w.codes.at(-1) ?? null
  }
}
