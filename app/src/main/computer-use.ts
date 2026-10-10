import { execFile, type ChildProcess } from 'child_process'
import {
  app,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  systemPreferences
} from 'electron'
import { existsSync, unlinkSync } from 'fs'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { kvGet, kvSet } from './store'
import { broadcastToWindows } from './util'
import {
  appFrom,
  cleanAppName,
  describeControls,
  riskyControl,
  SHOT_MAX_WIDTH,
  type UiControl,
  zoomRect,
  normalKeyCombo,
  ownerApp,
  typedLines,
  heldByAnother,
  isSelfApp,
  OFF_LIMITS_NAMES,
  type AppRef,
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

/**
 * Read from the store once, then held here and changed only by the user in
 * Settings. An agent's shell can write to the store's file; that must not be a
 * way to turn this on, or to empty the list of apps it stays out of.
 */
let enabledNow: boolean | null = null
let deniedNow: AppRef[] | null = null

export function computerUseEnabled(): boolean {
  if (enabledNow === null) enabledNow = kvGet(KEY) === '1'
  return process.platform === 'darwin' && enabledNow
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
  return new Promise((resolve) => {
    let child: ChildProcess | undefined = undefined
    child = execFile(bin, args, { timeout: 20_000 }, (err, stdout) => {
      if (child) running.delete(child)
      let out: Record<string, unknown> = {}
      try {
        out = JSON.parse(String(stdout).trim().split('\n').pop() || '{}')
      } catch {
        // not JSON: treated as a failure below
      }
      const error = typeof out.error === 'string' ? out.error : err ? err.message : ''
      resolve({ ok: !err && out.ok !== false, out, error })
    })
    // Only the ones that post events are worth cutting short.
    if (child && !['at', 'windows', 'pos', 'trusted', 'parent'].includes(args[0]))
      running.add(child)
  })
}

/** Helper runs that are posting events right now, so Stop can end one mid-way. */
const running = new Set<ChildProcess>()

export interface ComputerStatus {
  supported: boolean
  enabled: boolean
  /** Screen Recording: lets it see. */
  screen: boolean
  /** Accessibility: lets it move the pointer and type. */
  accessibility: boolean
  helper: boolean
  /** macOS would not give us ⌥Esc (another app has it): only the Stop buttons work. */
  stopKeyRefused: boolean
  /** Apps it never works in: the built-in ones by name, and the user's own. */
  builtInDenied: string[]
  denied: AppRef[]
}

export function computerStatus(): ComputerStatus {
  const mac = process.platform === 'darwin'
  return {
    supported: mac,
    enabled: computerUseEnabled(),
    screen: mac && systemPreferences.getMediaAccessStatus('screen') === 'granted',
    accessibility: mac && systemPreferences.isTrustedAccessibilityClient(false),
    helper: cusePath() !== null,
    stopKeyRefused: stopRefused,
    builtInDenied: OFF_LIMITS_NAMES,
    denied: deniedApps()
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

/**
 * Whether a conversation may look at the screen now, by any means: a picture,
 * a closer picture, or the names of its controls. Throws what to tell the
 * agent; returns the app in front.
 */
async function mayLook(owner: string): Promise<AppRef | null> {
  // Not a picture of the user's passwords either.
  const front = await frontApp()
  const no = offLimitsMessage(front)
  if (no) throw new Error(no)
  // Not only the app in front: a window beside it would be in the picture too.
  const showing = (await appsOnScreen()).find((a) => offLimitsMessage(a))
  if (showing)
    throw new Error(
      `${offLimitsApp(showing.id, deniedApps()) === 'a macOS password or permission prompt' ? 'A macOS password or permission prompt' : showing.name} is on screen, and computer use does not look at it. Ask the user to answer or close it, or to hide that window, then try again.`
    )
  claim(owner)
  return front
}

/**
 * The controls of the window in front, by name, with where to click for each
 * on the last screenshot. Surer than reading small text off a picture.
 */
export async function readUi(
  owner: string
): Promise<{ app: string; window: string; lines: string[] }> {
  const front = await mayLook(owner)
  // With no screenshot yet, the controls are placed on the picture one would
  // be: the display the pointer is on, at the size a screenshot of it has. The
  // points it gives are then good for a click, and a later screenshot agrees.
  let shot = lastShot.get(owner)
  if (!shot) {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    shot = { ...shotSize(display.bounds), area: display.bounds }
    lastShot.set(owner, shot)
    sawFront(owner, front?.id ?? null)
    const at = pointerNow()
    if (at) pointerLeftAt.set(owner, at)
  }
  if (isSelfApp(front?.id))
    throw new Error(
      "Superagent's own window is in front; bring the app you mean to the front first."
    )
  const { ok, out, error } = await cuse(['ax', '160'])
  if (!ok && error) throw new Error(error)
  const controls = (Array.isArray(out.elements) ? out.elements : []) as UiControl[]
  allowed.set(owner, Date.now())
  return {
    app: typeof out.app === 'string' ? cleanAppName(out.app) : (front?.name ?? ''),
    window: typeof out.window === 'string' ? out.window : '',
    lines: describeControls(
      shot,
      controls.filter((c) => c && typeof c.role === 'string')
    )
  }
}

/** What clicking at a point would press, when it is something that needs asking about first. */
export async function riskAt(owner: string, action: ComputerAction): Promise<string | null> {
  if (action.type !== 'click') return null
  const args = cuseArgs(action, lastShot.get(owner))
  const { out } = await cuse(['axat', args[1], args[2]])
  const role = typeof out.role === 'string' ? out.role : ''
  const label = typeof out.label === 'string' ? out.label : ''
  const risk = riskyControl(role, label)
  return risk ? `Click "${label}": it ${risk}.` : null
}

/** Part of the screen, enlarged: for text too small to read on the whole picture. */
export async function takeZoom(
  owner: string,
  region: { x: number; y: number; width: number; height: number }
): Promise<{ jpeg: Buffer; width: number; height: number }> {
  const shot = lastShot.get(owner)
  if (!shot) throw new Error('Take a screenshot first: the region is measured on it.')
  const rect = zoomRect(shot, region)
  if (!rect) throw new Error('That region is outside the screenshot, or smaller than 20 pixels.')
  await mayLook(owner)
  const all = screen.getAllDisplays()
  const display =
    all.find((d) => d.bounds.x === shot.area.x && d.bounds.y === shot.area.y) ?? all[0]
  // The display at its real size, so the region has every pixel there is.
  const scale = Math.min(display.scaleFactor || 1, 2)
  const full = {
    width: Math.round(display.bounds.width * scale),
    height: Math.round(display.bounds.height * scale)
  }
  const picture = await capture(all.indexOf(display), String(display.id), full)
  const got = picture.image.getSize()
  const k = got.width / shot.width
  const cut = picture.image.crop({
    x: Math.round(rect.x * k),
    y: Math.round(rect.y * k),
    width: Math.max(1, Math.round(rect.width * k)),
    height: Math.max(1, Math.round(rect.height * k))
  })
  const size = cut.getSize()
  const out = size.width > SHOT_MAX_WIDTH ? cut.resize({ width: SHOT_MAX_WIDTH }) : cut
  allowed.set(owner, Date.now())
  return { jpeg: out.toJPEG(85), ...out.getSize() }
}

/** The apps with a window on screen, and which is in front. */
export async function appsShowing(owner: string): Promise<{ front: string; apps: string[] }> {
  const front = await mayLook(owner)
  const apps = (await appsOnScreen()).map((a) => a.name)
  return { front: front?.name ?? '', apps: [...new Set(apps)] }
}

export async function takeScreenshot(owner: string, display?: number): Promise<Screenshot> {
  const front = owner === '__check__' ? null : await mayLook(owner)
  sawFront(owner, front?.id ?? null)
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
  return consentStands(allowed.get(owner), now, grantedAt.get(owner), actionsDone.get(owner) ?? 0)
}

/** When the user last said yes for a conversation, and what it has done since. */
const grantedAt = new Map<string, number>()
const actionsDone = new Map<string, number>()

/** Still working, so not idle. Does not renew the yes itself. */
export function touchConsent(owner: string, now = Date.now()): void {
  if (allowed.has(owner)) allowed.set(owner, now)
}

/**
 * Whether a point on the screen is on one of Superagent's own floating
 * surfaces (the dot and its panel, which can hold an Allow button). Set by
 * index.ts, to keep this module free of the windows.
 */
let onOwnSurface: (x: number, y: number) => boolean = () => false
export function setOwnSurfaceProbe(fn: (x: number, y: number) => boolean): void {
  onOwnSurface = fn
}

export function grantConsent(owner: string, now = Date.now()): void {
  grantedAt.set(owner, now)
  actionsDone.set(owner, 0)
  // From the moment of the yes, not only from the first action.
  holdStopKey()
  // A new yes starts over: each app is asked about again.
  approved.delete(owner)
  allowed.set(owner, now)
}

/** Everything stops: every yes is withdrawn and each agent using the Mac is interrupted. */
export function stopComputerUse(): string[] {
  const stopped = [...allowed.keys()]
  // Whatever is being typed or dragged right now ends here, not when it is done.
  for (const child of running) child.kill('SIGKILL')
  running.clear()
  allowed.clear()
  grantedAt.clear()
  actionsDone.clear()
  approved.clear()
  holder = null
  for (const id of stopped) onStop?.(id)
  setActive(false)
  return stopped
}

/** Whether ⌥Esc is ours right now, and whether macOS refused it to us. */
let stopRefused = false

function holdStopKey(): void {
  if (stopHeld) return
  try {
    stopHeld = globalShortcut.register(COMPUTER_STOP_HOTKEY, () => {
      stopComputerUse()
      broadcastToWindows('computer:stopped')
    })
  } catch {
    stopHeld = false
  }
  stopRefused = !stopHeld
}

function releaseStopKey(): void {
  if (!stopHeld) return
  globalShortcut.unregister(COMPUTER_STOP_HOTKEY)
  stopHeld = false
}

const anyConsent = (): boolean => [...allowed.keys()].some((o) => hasConsent(o))

/**
 * The indicator follows activity: on with an action, off after a quiet while.
 * The stop key does not: it is held for as long as any conversation still has
 * a yes, so it works while the agent is thinking between two steps.
 */
function setActive(on: boolean): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (on) {
    holdStopKey()
    idleTimer = setTimeout(() => setActive(false), 20_000)
  } else if (anyConsent()) {
    // Look again once the yes could have lapsed.
    idleTimer = setTimeout(() => setActive(false), 60_000)
    idleTimer.unref?.()
  } else releaseStopKey()
  broadcastToWindows('computer:active', on)
}

/** The app in front: where a key press or typed text would go. Null if macOS will not say. */
export function frontApp(): Promise<AppRef | null> {
  return new Promise((resolve) =>
    execFile('/usr/bin/lsappinfo', ['front'], { timeout: 4000 }, (err, asn) => {
      if (err || !String(asn).trim()) return resolve(null)
      execFile(
        '/usr/bin/lsappinfo',
        ['info', '-only', 'bundleid', '-only', 'name', String(asn).trim()],
        { timeout: 4000 },
        (e, out) => resolve(e ? null : appFrom(String(out)))
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
// --- the user's own list of apps to stay out of ---------------------------

const DENIED_KEY = 'computer.denied'

export function deniedApps(): AppRef[] {
  if (deniedNow) return deniedNow
  try {
    const saved = JSON.parse(kvGet(DENIED_KEY) || '[]') as AppRef[]
    deniedNow = Array.isArray(saved)
      ? saved.filter((a) => a && typeof a.id === 'string' && typeof a.name === 'string')
      : []
  } catch {
    deniedNow = []
  }
  return deniedNow
}

export function denyApp(app: AppRef): AppRef[] {
  const rest = deniedApps().filter((a) => a.id.toLowerCase() !== app.id.toLowerCase())
  const next = [...rest, app].sort((a, b) => a.name.localeCompare(b.name))
  deniedNow = next
  kvSet(DENIED_KEY, JSON.stringify(next))
  return next
}

export function undenyApp(id: string): AppRef[] {
  const next = deniedApps().filter((a) => a.id.toLowerCase() !== id.toLowerCase())
  deniedNow = next
  kvSet(DENIED_KEY, JSON.stringify(next))
  return next
}

/** The app in a .app folder, read from its Info.plist. Null when it is not one. */
export function appAtPath(path: string): Promise<AppRef | null> {
  const plist = join(path, 'Contents', 'Info.plist')
  const read = (key: string): Promise<string> =>
    new Promise((resolve) =>
      execFile('/usr/bin/plutil', ['-extract', key, 'raw', plist], { timeout: 4000 }, (e, out) =>
        resolve(e ? '' : String(out).trim())
      )
    )
  return Promise.all([
    read('CFBundleIdentifier'),
    read('CFBundleDisplayName'),
    read('CFBundleName')
  ]).then(([id, display, name]) =>
    id ? { id, name: display || name || basename(path).replace(/\.app$/, '') } : null
  )
}

/**
 * Why this app is out of bounds, or null. `acting` is for the mouse and
 * keyboard, which Superagent's own window is closed to as well; looking at
 * the screen while Superagent is in front is fine.
 */
function offLimitsMessage(app: AppRef | null, acting = false): string | null {
  if (acting && isSelfApp(app?.id))
    return "That is Superagent's own window, and computer use does not work in it. Use computer_open_mac_app to bring the app you need to the front, or the other tools for anything inside Superagent."
  const name = offLimitsApp(app?.id, deniedApps())
  if (!name) return null
  if (name === 'the lock screen')
    return 'This Mac is locked. Nothing can be done on it until the user unlocks it; do not try to.'
  return OFF_LIMITS_NAMES.includes(name) || name === 'a macOS password prompt'
    ? `${name} is in the way, and computer use does not operate in it: it holds the user's secrets. Ask the user to do that part themselves, or to bring another app to the front.`
    : `The user has put ${name} out of bounds for computer use (Settings → General → Computer use). Do not look for a way round it; say which part they have to do themselves.`
}

export async function offLimitsNow(): Promise<string | null> {
  return offLimitsMessage(await frontApp())
}

/** Whose window is at a point on the screen: what a click there lands on. */
function appAt(x: string, y: string): Promise<AppRef | null> {
  return cuse(['at', x, y]).then(({ out }) =>
    ownerApp(
      typeof out.name === 'string' ? out.name : '',
      typeof out.bundle === 'string' ? out.bundle : ''
    )
  )
}

/** Every app with a window on screen now. Empty when the helper cannot say. */
function appsOnScreen(): Promise<AppRef[]> {
  return cuse(['windows']).then(({ out }) =>
    (Array.isArray(out.apps) ? (out.apps as { name?: unknown; bundle?: unknown }[]) : [])
      .map((a) =>
        ownerApp(
          typeof a.name === 'string' ? a.name : '',
          typeof a.bundle === 'string' ? a.bundle : ''
        )
      )
      .filter((a): a is AppRef => !!a)
  )
}

/**
 * Superagent's own windows and shortcuts, asked of index.ts so this module
 * stays free of them. `focused`: one of its windows has the keyboard, which
 * the dot's panel can have without Superagent being the app in front.
 */
let own: { focused: () => boolean; shortcuts: () => string[] } = {
  focused: () => false,
  shortcuts: () => []
}
export function setOwnProbe(p: typeof own): void {
  own = p
}

/**
 * The apps an action would touch. The mouse touches whatever is under the
 * point (both ends of a drag), which need not be the app in front; the
 * keyboard goes to the app in front. Where a point is on no app's window (the
 * menu bar, the desktop), it is the app in front that answers.
 */
export async function targetApps(owner: string, action: ComputerAction): Promise<AppRef[]> {
  const args = cuseArgs(action, lastShot.get(owner))
  const front = await frontApp()
  const found: (AppRef | null)[] = []
  if (action.type === 'type' || action.type === 'key') found.push(front)
  else {
    found.push((await appAt(args[1], args[2])) ?? front)
    if (action.type === 'drag') found.push((await appAt(args[3], args[4])) ?? front)
  }
  const seen = new Set<string>()
  return found.filter((a): a is AppRef => !!a && !seen.has(a.id) && !!seen.add(a.id))
}

// --- one app at a time, asked about ---------------------------------------

/** The apps each conversation has been allowed to work in. */
const approved = new Map<string, Set<string>>()

export function approveApp(owner: string, id: string): void {
  if (!approved.has(owner)) approved.set(owner, new Set())
  approved.get(owner)!.add(id.toLowerCase())
}

/**
 * The apps this action would touch that the user has not yet said yes to, for
 * this conversation. Ones that are out of bounds are not asked about: the
 * action is refused instead.
 */
export async function appsToAsk(owner: string, action: ComputerAction): Promise<AppRef[]> {
  const ok = approved.get(owner)
  return (await targetApps(owner, action)).filter(
    (a) => !ok?.has(a.id.toLowerCase()) && !offLimitsMessage(a, true)
  )
}

// --- one conversation at a time --------------------------------------------

let holder: { owner: string; at: number } | null = null

/** Take the Mac for this conversation, or say why not. */
function claim(owner: string): void {
  if (heldByAnother(holder, owner, Date.now()))
    throw new Error(
      'Another conversation is using this Mac right now, and two cannot share one pointer and keyboard. Wait a minute and try again, or tell the user.'
    )
  holder = { owner, at: Date.now() }
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
  // The lock screen and a password manager in front stop everything; then each
  // app the action would actually touch is checked, which for the mouse is
  // whatever is under the point.
  const no =
    offLimitsMessage(front) ??
    (await targetApps(owner, action)).map((a) => offLimitsMessage(a, true)).find(Boolean)
  if (no) throw new Error(no)
  // The dot floats over other apps' windows, so the window under the point is
  // not the whole story: its panel is where an Allow button can be.
  const pts = args.slice(1, action.type === 'drag' ? 5 : 3).map(Number)
  if (
    action.type !== 'type' &&
    action.type !== 'key' &&
    (onOwnSurface(pts[0], pts[1]) || (action.type === 'drag' && onOwnSurface(pts[2], pts[3])))
  )
    throw new Error(
      "That point is on Superagent's own dot, and computer use does not click its own controls. If the dot is in the way, ask the user to move it."
    )
  // The yes was for this conversation, a while ago: check it still stands here
  // too, not only in the tools.
  if (!hasConsent(owner))
    throw new Error(
      'The user has not allowed this conversation to use the Mac. Ask again through the tool.'
    )
  claim(owner)
  const keys = action.type === 'type' || action.type === 'key'
  // Not knowing where keys would go is a reason not to send them.
  if (keys && !front)
    throw new Error(
      'macOS would not say which app is in front, so nothing was typed. Take a screenshot and try again.'
    )
  // The dot's panel can hold the keyboard while another app is "in front".
  if (keys && own.focused())
    throw new Error(
      "The keyboard is in Superagent's own window, and computer use does not type there. Click in the app you mean first, or use computer_open_mac_app."
    )
  if (
    action.type === 'key' &&
    [COMPUTER_STOP_HOTKEY, ...own.shortcuts()].some(
      (k) => normalKeyCombo(k) === normalKeyCombo(action.keys)
    )
  )
    throw new Error(
      "That is one of Superagent's own shortcuts, and computer use does not press it."
    )
  // Keys go to whatever is in front. If that is no longer the app the agent
  // was looking at, the text would land somewhere it has not seen.
  const seen = frontAtLook.get(owner)
  if ((action.type === 'type' || action.type === 'key') && focusMoved(seen, front?.id))
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
  actionsDone.set(owner, (actionsDone.get(owner) ?? 0) + 1)
  setActive(true)
  // Text with Return in it can open something else part-way (Spotlight, then
  // an app): it goes a line at a time, and stops if the app in front changes.
  const parts = action.type === 'type' ? typedLines(action.text) : null
  if (parts && parts.length > 1) {
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) {
        const now = await frontApp()
        if (!hasConsent(owner)) throw new Error('Stopped by the user.')
        if (!now || now.id.toLowerCase() !== front?.id.toLowerCase())
          throw new Error(
            `Typing stopped after ${i} line${i === 1 ? '' : 's'}: pressing Return brought ${now?.name ?? 'another app'} to the front, and the rest was not typed there. Take a screenshot to see where things are.`
          )
      }
      const r = await cuse(['type', parts[i]])
      if (!r.ok) throw new Error(r.error || 'The action could not be carried out.')
    }
  } else {
    const res = await cuse(args)
    if (!res.ok) throw new Error(res.error || 'The action could not be carried out.')
  }
  const at = pointerNow()
  if (at) pointerLeftAt.set(owner, at)
  else pointerLeftAt.delete(owner)
}

/** Let what was just done show on screen before it is photographed. */
export const settle = (ms = 450): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function registerComputerUseIpc(): void {
  ipcMain.handle('computer:status', () => computerStatus())
  /** Pick an app to keep computer use out of. */
  ipcMain.handle('computer:deny-pick', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Keep computer use out of an app',
      buttonLabel: 'Keep out',
      defaultPath: '/Applications',
      properties: ['openFile'],
      filters: [{ name: 'Apps', extensions: ['app'] }]
    })
    const path = picked.canceled ? null : picked.filePaths[0]
    const found = path ? await appAtPath(path) : null
    if (found) denyApp(found)
    return computerStatus()
  })
  ipcMain.handle('computer:deny', (_e, app: AppRef) => {
    if (app && typeof app.id === 'string' && app.id)
      denyApp({ id: app.id, name: String(app.name || app.id) })
    return computerStatus()
  })
  ipcMain.handle('computer:undeny', (_e, id: string) => {
    undenyApp(String(id))
    return computerStatus()
  })
  ipcMain.handle('computer:set-enabled', (_e, on: boolean) => {
    enabledNow = !!on
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
