import { execFile } from 'child_process'
import {
  app,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  systemPreferences
} from 'electron'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { kvGet, kvSet } from './store'
import { broadcastToWindows } from './util'
import {
  bundleIdFrom,
  COMPUTER_STOP_HOTKEY,
  consentStands,
  focusMoved,
  pointerMoved,
  offLimitsApp,
  shotSize,
  toScreenPoint,
  type Shot
} from '../shared/computer-use'

/**
 * Computer use: the agent looking at this Mac's screen and working its mouse
 * and keyboard, in any app. Off unless turned on in Settings, and then only
 * with the two permissions macOS keeps for exactly this: Screen Recording, to
 * see, and Accessibility, to act.
 *
 * Seeing is a screenshot of one display, scaled so it is cheap to send on
 * every step. Acting is native/cuse.c, which posts the events a mouse and a
 * keyboard post. Points are named on the screenshot and mapped back to the
 * screen here, so the agent never needs to know about scale or displays.
 *
 * Three things keep it in hand. A conversation has to be allowed to use the
 * Mac before its first action, and is asked again once it has been idle. While
 * anything is being controlled, ⌥Esc stops it from whatever app is in front.
 * And the windows are told, so there is something on screen that says so.
 */

const KEY = 'computer.enabled'

export function computerUseEnabled(): boolean {
  return process.platform === 'darwin' && kvGet(KEY) === '1'
}

function cusePath(): string | null {
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'cuse')]
    : [join(__dirname, '../../native/cuse'), join(process.cwd(), 'native/cuse')]
  for (const p of candidates) if (existsSync(p)) return p
  return null
}

function cuse(
  args: string[]
): Promise<{ ok: boolean; out: Record<string, unknown>; error: string }> {
  const bin = cusePath()
  if (!bin)
    return Promise.resolve({ ok: false, out: {}, error: 'The computer-use helper is missing.' })
  return new Promise((resolve) =>
    execFile(bin, args, { timeout: 20_000 }, (err, stdout) => {
      let out: Record<string, unknown> = {}
      try {
        out = JSON.parse(String(stdout).trim().split('\n').pop() || '{}')
      } catch {
        // not JSON: treated as a failure below
      }
      const error = typeof out.error === 'string' ? out.error : err ? err.message : ''
      resolve({ ok: !err && out.ok !== false, out, error })
    })
  )
}

export interface ComputerStatus {
  supported: boolean
  enabled: boolean
  /** Screen Recording: lets it see. */
  screen: boolean
  /** Accessibility: lets it move the pointer and type. */
  accessibility: boolean
  helper: boolean
}

export function computerStatus(): ComputerStatus {
  const mac = process.platform === 'darwin'
  return {
    supported: mac,
    enabled: computerUseEnabled(),
    screen: mac && systemPreferences.getMediaAccessStatus('screen') === 'granted',
    accessibility: mac && systemPreferences.isTrustedAccessibilityClient(false),
    helper: cusePath() !== null
  }
}

/** What is missing, in the words the agent passes on to the user. Null when ready. */
export function notReady(s: ComputerStatus = computerStatus()): string | null {
  if (!s.supported) return 'Computer use needs a Mac.'
  if (!s.enabled)
    return 'Computer use is turned off. The user can turn it on in Settings → General → Computer use.'
  if (!s.helper) return 'The computer-use helper is missing from this build.'
  const missing = [
    s.screen ? null : 'Screen Recording (to see the screen)',
    s.accessibility ? null : 'Accessibility (to move the pointer and type)'
  ].filter(Boolean)
  return missing.length
    ? `Superagent does not have ${missing.join(' or ')}. The user grants ${missing.length > 1 ? 'them' : 'it'} in System Settings → Privacy & Security; Settings → General → Computer use has buttons that open the right page. macOS may ask for Superagent to be restarted afterwards.`
    : null
}

// --- seeing ---------------------------------------------------------------

/** How the last screenshot was taken, for the Settings check. */
let lastVia: 'capturer' | 'screencapture' = 'capturer'

/**
 * A picture of one display at the given size. Electron's own capturer first;
 * where it hands back nothing (it lists no screens at all on some systems
 * without saying why), macOS's `screencapture`, which the same permission
 * covers.
 */
async function capture(
  index: number,
  displayId: string,
  size: { width: number; height: number }
): Promise<{ image: Electron.NativeImage; via: 'capturer' | 'screencapture' }> {
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size })
    const source = sources.find((s) => s.display_id === displayId) ?? sources[0]
    if (source && !source.thumbnail.isEmpty()) return { image: source.thumbnail, via: 'capturer' }
  } catch {
    // fall through to screencapture
  }
  const file = join(tmpdir(), `sa-screen-${process.pid}-${Date.now()}.jpg`)
  try {
    await new Promise<void>((resolve, reject) =>
      execFile(
        '/usr/sbin/screencapture',
        // No sound, no cursor-wait, this display only (screencapture counts from 1).
        ['-x', '-t', 'jpg', '-D', String(index + 1), file],
        { timeout: 15_000 },
        (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message))) : resolve())
      )
    )
    const full = nativeImage.createFromPath(file)
    if (full.isEmpty()) throw new Error('empty')
    return {
      image: full.resize({ width: size.width, height: size.height, quality: 'good' }),
      via: 'screencapture'
    }
  } catch {
    throw new Error(
      'The screen could not be captured. Superagent may not have Screen Recording yet: System Settings → Privacy & Security → Screen Recording, then restart Superagent.'
    )
  } finally {
    try {
      unlinkSync(file)
    } catch {
      // never written
    }
  }
}

/** The last screenshot of each conversation: what its points are measured on. */
const lastShot = new Map<string, Shot>()

export interface Screenshot {
  shot: Shot
  jpeg: Buffer
  /** Every display, so the agent can ask for another by number. */
  displays: { index: number; width: number; height: number; current: boolean }[]
}

export async function takeScreenshot(owner: string, display?: number): Promise<Screenshot> {
  // Not a picture of the user's passwords either.
  const front = owner === '__check__' ? null : await frontApp()
  const no = offLimitsMessage(front)
  if (no) throw new Error(no)
  sawFront(owner, front)
  // Where the pointer is at this look: every action is followed by one, so a
  // pointer found elsewhere at the next action was moved by the user.
  const at = pointerNow()
  if (at) pointerLeftAt.set(owner, at)
  else pointerLeftAt.delete(owner)
  const all = screen.getAllDisplays()
  // The one asked for; else the one last used; else the one the pointer is on,
  // which is where the person is looking.
  const prior = lastShot.get(owner)
  const byPrior =
    prior && all.find((d) => d.bounds.x === prior.area.x && d.bounds.y === prior.area.y)
  const chosen =
    (display !== undefined && all[display]) ||
    byPrior ||
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const size = shotSize(chosen.bounds)
  const picture = await capture(all.indexOf(chosen), String(chosen.id), size)
  const got = picture.image.getSize()
  const shot: Shot = { width: got.width, height: got.height, area: chosen.bounds }
  lastShot.set(owner, shot)
  lastVia = picture.via
  return {
    shot,
    jpeg: picture.image.toJPEG(72),
    displays: all.map((d, index) => ({
      index,
      width: d.bounds.width,
      height: d.bounds.height,
      current: d.id === chosen.id
    }))
  }
}

// --- acting ----------------------------------------------------------------

export type ComputerAction =
  | { type: 'move'; x: number; y: number }
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number }
  | { type: 'drag'; x: number; y: number; toX: number; toY: number }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string }

/** The helper's arguments for an action, its points mapped onto the screen. Throws what to tell the agent. */
export function cuseArgs(action: ComputerAction, shot: Shot | undefined): string[] {
  const at = (x: number, y: number): [string, string] => {
    if (!shot) throw new Error('Take a computer_screenshot first: points are measured on it.')
    const p = toScreenPoint(shot, x, y)
    if (!p)
      throw new Error(
        `(${x}, ${y}) is outside the screenshot, which is ${shot.width}×${shot.height}. Take a new one and use its coordinates.`
      )
    return [String(p.x), String(p.y)]
  }
  switch (action.type) {
    case 'move':
      return ['move', ...at(action.x, action.y)]
    case 'click':
      return [
        'click',
        ...at(action.x, action.y),
        action.button ?? 'left',
        String(Math.min(3, Math.max(1, Math.round(action.count ?? 1))))
      ]
    case 'drag':
      return ['drag', ...at(action.x, action.y), ...at(action.toX, action.toY)]
    case 'scroll':
      return [
        'scroll',
        ...at(action.x, action.y),
        String(Math.round(action.dx)),
        String(Math.round(action.dy))
      ]
    case 'type':
      return ['type', action.text]
    case 'key':
      return ['key', action.keys.toLowerCase()]
  }
}

// --- consent, and stopping ---------------------------------------------------

/** When each conversation last used the Mac with the user's yes. */
const allowed = new Map<string, number>()
let stopHeld = false
let idleTimer: ReturnType<typeof setTimeout> | null = null
let onStop: ((chatId: string) => void) | null = null

/** Who to tell to stop a conversation's agent (set by mcp.ts, to keep this module free of it). */
export function setComputerStop(fn: (chatId: string) => void): void {
  onStop = fn
}

export function hasConsent(owner: string, now = Date.now()): boolean {
  return consentStands(allowed.get(owner), now)
}

export function grantConsent(owner: string, now = Date.now()): void {
  allowed.set(owner, now)
}

/** Everything stops: every yes is withdrawn and each agent using the Mac is interrupted. */
export function stopComputerUse(): string[] {
  const stopped = [...allowed.keys()]
  allowed.clear()
  for (const id of stopped) onStop?.(id)
  setActive(false)
  return stopped
}

function setActive(on: boolean): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (on) {
    if (!stopHeld) {
      try {
        stopHeld = globalShortcut.register(COMPUTER_STOP_HOTKEY, () => {
          stopComputerUse()
          broadcastToWindows('computer:stopped')
        })
      } catch {
        stopHeld = false
      }
    }
    // Quiet for a while: it is no longer "in control", and the shortcut is
    // given back so it does not sit on ⌥Esc all day.
    idleTimer = setTimeout(() => setActive(false), 20_000)
  } else if (stopHeld) {
    globalShortcut.unregister(COMPUTER_STOP_HOTKEY)
    stopHeld = false
  }
  broadcastToWindows('computer:active', on)
}

/** The app in front: where a key press or typed text would go. Null if macOS will not say. */
export function frontApp(): Promise<string | null> {
  return new Promise((resolve) =>
    execFile('/usr/bin/lsappinfo', ['front'], { timeout: 4000 }, (err, asn) => {
      if (err || !String(asn).trim()) return resolve(null)
      execFile(
        '/usr/bin/lsappinfo',
        ['info', '-only', 'bundleid', String(asn).trim()],
        { timeout: 4000 },
        (e, out) => resolve(e ? null : bundleIdFrom(String(out)))
      )
    })
  )
}

/**
 * Why the Mac must not be used right now, or null. The lock screen and the
 * apps where secrets live are out of bounds whatever was asked: an agent has
 * no business typing into a password manager, and anything aimed at a locked
 * Mac is aimed at its password field.
 */
function offLimitsMessage(front: string | null): string | null {
  const name = offLimitsApp(front)
  if (!name) return null
  return name === 'the lock screen'
    ? 'This Mac is locked. Nothing can be done on it until the user unlocks it; do not try to.'
    : `${name} is in front, and computer use does not operate in it: it holds the user's secrets. Ask the user to do that part themselves, or to bring another app to the front.`
}

export async function offLimitsNow(): Promise<string | null> {
  return offLimitsMessage(await frontApp())
}

/** Where the pointer was when each conversation last looked, or last acted. */
const pointerLeftAt = new Map<string, { x: number; y: number }>()

/** For a test: as if an action had just left the pointer here. */
export function leftPointerAt(owner: string, at: { x: number; y: number }): void {
  pointerLeftAt.set(owner, at)
}

function pointerNow(): { x: number; y: number } | null {
  try {
    return screen.getCursorScreenPoint()
  } catch {
    return null
  }
}

/** The app that was in front when each conversation last looked at the screen. */
const frontAtLook = new Map<string, string>()

/** Record which app was in front for a look. Unknown is not recorded. */
export function sawFront(owner: string, bundleId: string | null): void {
  if (bundleId) frontAtLook.set(owner, bundleId)
  else frontAtLook.delete(owner)
}

/** Do one thing with the mouse or keyboard, for a conversation that has been allowed to. */
export async function act(owner: string, action: ComputerAction): Promise<void> {
  const args = cuseArgs(action, lastShot.get(owner))
  const front = await frontApp()
  const no = offLimitsMessage(front)
  if (no) throw new Error(no)
  // Keys go to whatever is in front. If that is no longer the app the agent
  // was looking at, the text would land somewhere it has not seen.
  const seen = frontAtLook.get(owner)
  if ((action.type === 'type' || action.type === 'key') && focusMoved(seen, front))
    throw new Error(
      'Another app has come to the front since you last looked at the screen, so nothing was typed. Take a screenshot and check where the cursor is before trying again.'
    )
  // The pointer is not where it was at the last look: the user has their hand
  // on the mouse. Stand back until the agent has looked again.
  if (pointerMoved(pointerLeftAt.get(owner), pointerNow())) {
    pointerLeftAt.delete(owner)
    throw new Error(
      'The user moved the mouse since you last looked at the screen, so nothing was done: they may be using the Mac themselves. Take a screenshot to see what changed before going on.'
    )
  }
  allowed.set(owner, Date.now())
  setActive(true)
  const res = await cuse(args)
  if (!res.ok) throw new Error(res.error || 'The action could not be carried out.')
  const at = pointerNow()
  if (at) pointerLeftAt.set(owner, at)
  else pointerLeftAt.delete(owner)
}

/** Let what was just done show on screen before it is photographed. */
export const settle = (ms = 450): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function registerComputerUseIpc(): void {
  ipcMain.handle('computer:status', () => computerStatus())
  ipcMain.handle('computer:set-enabled', (_e, on: boolean) => {
    kvSet(KEY, on ? '1' : '0')
    if (!on) stopComputerUse()
    return computerStatus()
  })
  /** Ask macOS for a permission, which shows its own prompt the first time. */
  ipcMain.handle('computer:request', async (_e, which: 'screen' | 'accessibility') => {
    if (process.platform !== 'darwin') return computerStatus()
    if (which === 'accessibility') systemPreferences.isTrustedAccessibilityClient(true)
    else {
      // Asking for a capture is what makes macOS list the app under Screen Recording.
      await desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } })
        .catch(() => [])
    }
    return computerStatus()
  })
  ipcMain.handle('computer:open-settings', (_e, which: 'screen' | 'accessibility') =>
    shell.openExternal(
      `x-apple.systempreferences:com.apple.preference.security?${
        which === 'screen' ? 'Privacy_ScreenCapture' : 'Privacy_Accessibility'
      }`
    )
  )
  ipcMain.handle('computer:stop', () => stopComputerUse())
  /**
   * "Check it works", from Settings: really look, and really ask the helper
   * whether it may act, rather than trusting what macOS says it has granted
   * (which can be out of date until the app restarts). Moves nothing.
   */
  ipcMain.handle('computer:check', async () => {
    const out = { see: false, act: false, via: '', size: '', error: '' }
    try {
      const s = await takeScreenshot('__check__')
      out.see = true
      out.via = lastVia
      out.size = `${s.shot.width}×${s.shot.height}`
    } catch (e) {
      out.error = (e as Error).message
    }
    lastShot.delete('__check__')
    const t = await cuse(['trusted'])
    out.act = t.out.trusted === true
    if (!out.act && !out.error)
      out.error =
        'Superagent may not move the pointer or type yet: System Settings → Privacy & Security → Accessibility.'
    return out
  })
  app.on('will-quit', () => {
    if (stopHeld) globalShortcut.unregister(COMPUTER_STOP_HOTKEY)
  })
}
