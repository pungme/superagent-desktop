/**
 * Computer use, the parts that are only arithmetic: how big a screenshot the
 * agent is given, and where a point it names on that picture is on the screen.
 */

export interface ScreenArea {
  /** In points, in the system's own coordinate space (top left of the main display is 0,0). */
  x: number
  y: number
  width: number
  height: number
}

export interface Shot {
  /** The picture's size in pixels: what the agent sees and names points in. */
  width: number
  height: number
  /** The display it is a picture of. */
  area: ScreenArea
}

/** Wide enough to read a menu, small enough to send every step. */
export const SHOT_MAX_WIDTH = 1440

/** The size a display is photographed at: its own, or scaled to the cap, never up. */
export function shotSize(
  area: ScreenArea,
  max = SHOT_MAX_WIDTH
): { width: number; height: number } {
  const scale = Math.min(1, max / area.width)
  return { width: Math.round(area.width * scale), height: Math.round(area.height * scale) }
}

/**
 * A point on the screenshot as a point on the screen. Null when it is outside
 * the picture: a click there would land on another display, or nowhere.
 */
export function toScreenPoint(shot: Shot, x: number, y: number): { x: number; y: number } | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  if (x < 0 || y < 0 || x > shot.width || y > shot.height) return null
  return {
    x: Math.round(shot.area.x + (x / shot.width) * shot.area.width),
    y: Math.round(shot.area.y + (y / shot.height) * shot.area.height)
  }
}

const MODIFIERS = new Set([
  'cmd',
  'command',
  'meta',
  'shift',
  'alt',
  'option',
  'opt',
  'ctrl',
  'control',
  'fn'
])

/** "cmd+shift+4": modifiers, then one key. Checked here so a bad one never reaches the helper. */
export function validKeyCombo(combo: string): boolean {
  if (combo !== combo.trim() || !combo) return false
  const parts = combo.toLowerCase().split('+')
  const key = parts.pop() ?? ''
  if (!parts.every((p) => MODIFIERS.has(p))) return false
  if (MODIFIERS.has(key)) return false
  return /^[a-z0-9]+$/.test(key) || /^[=\-[\];',./\\`]$/.test(key)
}

const MOD_NAMES: Record<string, string> = {
  cmd: 'cmd',
  command: 'cmd',
  meta: 'cmd',
  shift: 'shift',
  alt: 'opt',
  option: 'opt',
  opt: 'opt',
  ctrl: 'ctrl',
  control: 'ctrl',
  fn: 'fn'
}
const KEY_NAMES: Record<string, string> = { backspace: 'delete', escape: 'esc', enter: 'return' }

/** A shortcut in one spelling, modifiers in a fixed order: "Shift+Command+Q" → "cmd+shift+q". */
export function normalKeyCombo(combo: string): string {
  const parts = combo.trim().toLowerCase().split('+')
  const key = parts.pop() ?? ''
  const mods = [...new Set(parts.map((p) => MOD_NAMES[p] ?? p))].sort()
  return [...mods, KEY_NAMES[key] ?? key].join('+')
}

/** Shortcuts that end, lose or destroy something, and what each does. */
const RISKY_SHORTCUTS: Record<string, string> = {
  'cmd+q': 'quits the app in front, and anything unsaved in it may be lost',
  'cmd+opt+q': 'quits the app in front and forgets its windows',
  'cmd+shift+q': 'logs you out of this Mac, closing every app',
  'cmd+opt+shift+q': 'logs you out of this Mac at once, without asking',
  'cmd+ctrl+q': 'locks this Mac',
  'cmd+esc+opt': 'opens Force Quit',
  'cmd+delete': 'moves what is selected to the Trash',
  'cmd+delete+shift': 'empties the Trash',
  'cmd+delete+opt+shift': 'empties the Trash without asking',
  'cmd+delete+opt': 'deletes what is selected at once, skipping the Trash',
  'cmd+shift+w': 'closes the whole window',
  'cmd+opt+w': 'closes every window of the app in front'
}
const RISKY = new Map(
  Object.entries(RISKY_SHORTCUTS).map(([k, v]) => [normalKeyCombo(reorderKeyLast(k)), v])
)
/** The table above is written loosely; put its one non-modifier last, as a combo is. */
function reorderKeyLast(combo: string): string {
  const parts = combo.split('+')
  const key = parts.find((p) => !MOD_NAMES[p]) ?? ''
  return [...parts.filter((p) => p !== key), key].join('+')
}

/**
 * What a shortcut would end, lose or destroy, or null for an ordinary one.
 * These are asked about every time, whatever has already been allowed.
 */
export function riskyShortcut(combo: string): string | null {
  return RISKY.get(normalKeyCombo(combo)) ?? null
}

/** How long a yes to "let it use this Mac" lasts without the agent doing anything. */
export const CONSENT_IDLE_MS = 10 * 60_000

/** Whether an earlier yes still stands: it does while the agent keeps working. */
export function consentStands(
  lastUsedAt: number | undefined,
  now: number,
  grantedAt?: number,
  actions = 0
): boolean {
  if (lastUsedAt === undefined || now - lastUsedAt >= CONSENT_IDLE_MS) return false
  if (grantedAt !== undefined && now - grantedAt >= CONSENT_MAX_MS) return false
  return actions < CONSENT_MAX_ACTIONS
}

/**
 * However busy the agent stays, one yes does not last for ever: after this
 * long, or this many actions, the user is asked again. A task that is going
 * well costs one more click; one that has run away is stopped.
 */
export const CONSENT_MAX_MS = 30 * 60_000
export const CONSENT_MAX_ACTIONS = 300

/** The shortcut that stops it, whatever app is in front. */
export const COMPUTER_STOP_HOTKEY = 'Alt+Escape'

/**
 * Apps computer use keeps its hands out of: where secrets are kept, and the
 * lock screen. Matched on the bundle id's start, so a vendor's helper apps
 * and new major versions are covered too.
 */
const OFF_LIMITS: [prefix: string, name: string][] = [
  ['com.apple.loginwindow', 'the lock screen'],
  ['com.apple.Passwords', 'Passwords'],
  ['com.apple.keychainaccess', 'Keychain Access'],
  ['com.1password.', '1Password'],
  ['com.agilebits.onepassword', '1Password'],
  ['com.bitwarden.', 'Bitwarden'],
  ['com.lastpass.', 'LastPass'],
  ['com.dashlane.', 'Dashlane'],
  ['in.sinew.Enpass', 'Enpass'],
  ['org.keepassxc.', 'KeePassXC'],
  ['com.apple.SecurityAgent', 'a macOS password prompt']
]

/** How a window's owner is identified when it has no bundle id: by its process name. */
export const UNBUNDLED = 'name:'

/**
 * The processes that draw macOS's own password, Touch ID and permission
 * prompts. They are not apps, so they are known by name. An agent never
 * answers one of these: they are the user's to answer.
 */
const SYSTEM_PROMPTS = [
  'securityagent',
  'coreautha',
  'loginwindow',
  'universalaccessauthwarn',
  'coreservicesuiagent',
  'usernotificationcenter',
  'authorizationhost',
  'localauthenticationremoteservice'
]

/** A window's owner as an app: by bundle id, or by name when it has none. Null for the system's own chrome. */
export function ownerApp(name: string, bundle: string): AppRef | null {
  const clean = cleanAppName(name)
  if (bundle) return { id: bundle, name: clean || bundle }
  // The menu bar and the desktop belong to the window server: the app in front answers for them.
  if (!clean || clean === 'Window Server') return null
  return { id: `${UNBUNDLED}${clean}`, name: clean }
}

/** An app, as its bundle id and the name a person knows it by. */
export interface AppRef {
  id: string
  name: string
}

/**
 * The name of the off-limits app this bundle id belongs to, or null when it is
 * fine. `denied` is the user's own list, matched exactly.
 */
export function offLimitsApp(
  bundleId: string | null | undefined,
  denied: AppRef[] = []
): string | null {
  if (!bundleId) return null
  const id = bundleId.toLowerCase()
  // A window whose owner is not an app at all: known only by its process name.
  if (id.startsWith(UNBUNDLED))
    return SYSTEM_PROMPTS.includes(id.slice(UNBUNDLED.length))
      ? 'a macOS password or permission prompt'
      : null
  const builtIn = OFF_LIMITS.find(([prefix]) => id.startsWith(prefix.toLowerCase()))?.[1]
  return builtIn ?? denied.find((d) => d.id.toLowerCase() === id)?.name ?? null
}

/** The built-in list, as the names Settings shows. */
export const OFF_LIMITS_NAMES = [...new Set(OFF_LIMITS.map(([, name]) => name))].filter(
  (n) => !/lock screen|password prompt/.test(n)
)

/** Superagent itself, packaged and when run from source. */
const SELF_APPS = ['dev.superagent.app', 'com.github.electron']

/**
 * Whether this is Superagent's own app. An agent does not work its own
 * window: the button it would be clicking could be the Allow on its own request.
 */
export function isSelfApp(bundleId: string | null | undefined): boolean {
  return !!bundleId && SELF_APPS.includes(bundleId.toLowerCase())
}

/** The app in what `lsappinfo info -only bundleid -only name` prints, or null. */
export function appFrom(lsappinfo: string): AppRef | null {
  const id = bundleIdFrom(lsappinfo)
  if (!id) return null
  const name = /^\s*"([^"]+)"\s+ASN/m.exec(lsappinfo)?.[1] ?? ''
  return { id, name: cleanAppName(name) || id }
}

/** An app's name without the invisible marks some put in front of theirs. */
export function cleanAppName(name: string): string {
  return name.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim()
}

const CAUTIONS: [prefixes: string[], warning: string][] = [
  [
    [
      'com.apple.terminal',
      'com.googlecode.iterm2',
      'dev.warp.',
      'com.mitchellh.ghostty',
      'net.kovidgoyal.kitty',
      'co.zeit.hyper'
    ],
    'It is a terminal: anything typed there runs as a command on this Mac.'
  ],
  [
    ['com.microsoft.vscode', 'com.todesktop.', 'com.apple.dt.xcode', 'com.jetbrains.', 'dev.zed.'],
    'It is a code editor with a terminal: it can change your code and run commands.'
  ],
  [['com.apple.finder'], 'It can move, rename and delete your files there.'],
  [
    ['com.apple.systempreferences', 'com.apple.systemsettings'],
    'It can change how this Mac is set up.'
  ],
  [
    [
      'com.apple.safari',
      'com.google.chrome',
      'com.brave.browser',
      'com.microsoft.edgemac',
      'org.mozilla.firefox',
      'company.thebrowser.',
      'com.operasoftware.'
    ],
    'It acts as you on every site you are signed in to.'
  ],
  [
    ['com.apple.mail', 'com.apple.mobilesms', 'net.whatsapp.', 'com.tinyspeck.slackmacgap'],
    'It can read your messages there and send new ones as you.'
  ]
]

/** What to warn of before an agent works in this app. Empty for an ordinary one. */
export function appCaution(bundleId: string): string {
  const id = bundleId.toLowerCase()
  return CAUTIONS.find(([prefixes]) => prefixes.some((p) => id.startsWith(p)))?.[1] ?? ''
}

/** How long a conversation keeps the Mac to itself after its last look or action. */
export const LOCK_MS = 60_000

/**
 * Whether another conversation is using the Mac right now. Two agents sharing
 * one pointer and one keyboard would each undo what the other is doing.
 */
export function heldByAnother(
  holder: { owner: string; at: number } | null,
  owner: string,
  now: number
): boolean {
  return !!holder && holder.owner !== owner && now - holder.at < LOCK_MS
}

/** The bundle id in what `lsappinfo info -only bundleid` prints, or null. */
export function bundleIdFrom(lsappinfo: string): string | null {
  return /bundleID="([^"]+)"/i.exec(lsappinfo)?.[1] ?? null
}

/**
 * Whether a different app is in front now than at the last look. Not knowing
 * either one is not a move: macOS declining to say must not stop all typing.
 */
export function focusMoved(
  seen: string | null | undefined,
  now: string | null | undefined
): boolean {
  return !!seen && !!now && seen.toLowerCase() !== now.toLowerCase()
}

type Point = { x: number; y: number }

/**
 * Whether the pointer is somewhere other than where an action left it. A few
 * points of slack: a trackpad at rest and macOS's own rounding both wobble.
 */
export function pointerMoved(
  left: Point | null | undefined,
  now: Point | null | undefined
): boolean {
  if (!left || !now) return false
  return Math.hypot(now.x - left.x, now.y - left.y) > 6
}

/**
 * Text as the pieces it is typed in: each line with the Return that ends it.
 * One piece when there is no Return inside it.
 */
export function typedLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+/g) ?? []
}

/**
 * A point on the screen as a point on the screenshot: the other way from
 * toScreenPoint. Null when it is not on the display the picture is of.
 */
export function toShotPoint(shot: Shot, x: number, y: number): { x: number; y: number } | null {
  const a = shot.area
  if (x < a.x || y < a.y || x > a.x + a.width || y > a.y + a.height) return null
  return {
    x: Math.round(((x - a.x) / a.width) * shot.width),
    y: Math.round(((y - a.y) / a.height) * shot.height)
  }
}

/** A control on screen, as the accessibility tree describes it (screen points). */
export interface UiControl {
  /** Its number in the listing: what computer_press and computer_fill take. */
  i?: number
  role: string
  label: string
  value: string
  x: number
  y: number
  w: number
  h: number
  enabled: boolean
}

/**
 * The controls as lines an agent can act on: what each is, what it is called,
 * and the point on the screenshot to click for it. Ones with neither a name
 * nor a value are left out; ones off the pictured display are listed without
 * a point.
 */
export function describeControls(shot: Shot, controls: UiControl[], max = 120): string[] {
  const lines: string[] = []
  for (const c of controls) {
    const at = toShotPoint(shot, c.x + c.w / 2, c.y + c.h / 2)
    const label = c.label.replace(/\s+/g, ' ').trim()
    const value = c.value.replace(/\s+/g, ' ').trim()
    if (!label && !value) continue
    // One that is not on the pictured display has no point to click, but it can
    // still be pressed or filled by its number: that needs no point.
    lines.push(
      `${typeof c.i === 'number' ? `[${c.i}] ` : ''}${c.role.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()} ${label ? `"${label.slice(0, 80)}"` : '(no name)'}` +
        (value && value !== label
          ? ` = ${value === '(hidden)' ? '(hidden)' : `"${value.slice(0, 60)}"`}`
          : '') +
        `${c.enabled ? '' : ' (disabled)'}${at ? ` at ${at.x},${at.y}` : ' (not on this display: use its number)'}`
    )
    if (lines.length >= max) break
  }
  return lines
}

/**
 * What clicking a control would end, lose or destroy, going by what it is
 * called: a menu item or a button named Log Out, Shut Down, Empty Trash…
 * Null for an ordinary one. Asked about every time, like riskyShortcut.
 */
export function riskyControl(role: string, label: string): string | null {
  if (!/^AX(MenuItem|Button|MenuBarItem|PopUpButton|Link)$/.test(role)) return null
  const l = label
    .toLowerCase()
    .replace(/[….]+$/, '')
    .trim()
  const found = RISKY_LABELS.find(([pattern]) => pattern.test(l))
  return found ? found[1] : null
}

const RISKY_LABELS: [RegExp, string][] = [
  [/^log out\b/, 'logs you out of this Mac, closing every app'],
  [/^(shut down|restart)$/, 'shuts down or restarts this Mac'],
  [/^(empty (trash|bin)|delete immediately|erase\b.*)/, 'deletes for good, with no way back'],
  [/^(move to (trash|bin)|delete)$/, 'deletes what is selected'],
  [/^force quit/, 'force quits an app, losing anything unsaved'],
  [
    /^(quit|quit and .*|quit all.*)$|^quit \S/,
    'quits an app, and anything unsaved in it may be lost'
  ],
  [/^(sign out|sign out of .*)$/, 'signs you out of an account'],
  [
    /^(reset|erase all content and settings|restore defaults|factory reset).*$/,
    'resets settings or data'
  ],
  [/^(uninstall|remove account|delete account).*$/, 'removes an app or an account'],
  [
    /^(send|send now|send message|send email|send all|pay|pay now|buy|buy now|purchase|place order|confirm payment|confirm purchase|subscribe|transfer)$/,
    'sends something or spends money'
  ]
]

/** The part of a picture to enlarge, kept inside the picture and not absurdly small. */
export function zoomRect(
  shot: Shot,
  r: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } | null {
  const x = Math.max(0, Math.min(shot.width, Math.round(r.x)))
  const y = Math.max(0, Math.min(shot.height, Math.round(r.y)))
  const width = Math.min(shot.width - x, Math.round(r.width))
  const height = Math.min(shot.height - y, Math.round(r.height))
  return width >= 20 && height >= 20 ? { x, y, width, height } : null
}

/** Whether two rectangles on the desktop share any area. */
export function overlaps(a: ScreenArea, b: ScreenArea): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** The panes of System Settings an agent can open straight to, and their addresses. */
export const SETTINGS_PANES = {
  general: 'com.apple.systempreferences.GeneralSettings',
  appearance: 'com.apple.Appearance-Settings.extension',
  wifi: 'com.apple.wifi-settings-extension',
  bluetooth: 'com.apple.BluetoothSettings',
  network: 'com.apple.Network-Settings.extension',
  notifications: 'com.apple.Notifications-Settings.extension',
  sound: 'com.apple.Sound-Settings.extension',
  displays: 'com.apple.Displays-Settings.extension',
  battery: 'com.apple.Battery-Settings.extension',
  keyboard: 'com.apple.Keyboard-Settings.extension',
  trackpad: 'com.apple.Trackpad-Settings.extension',
  privacy: 'com.apple.preference.security?Privacy',
  accessibility: 'com.apple.preference.security?Privacy_Accessibility',
  'screen-recording': 'com.apple.preference.security?Privacy_ScreenCapture'
} as const

export type SettingsPane = keyof typeof SETTINGS_PANES

/** The address that opens System Settings at a pane. */
export function settingsUrl(pane: SettingsPane): string {
  return `x-apple.systempreferences:${SETTINGS_PANES[pane]}`
}

/** System Settings, as the app an agent is working in when it opens a pane. */
export const SYSTEM_SETTINGS: AppRef = {
  id: 'com.apple.systempreferences',
  name: 'System Settings'
}

/** The word under the ring that shows where an action is about to happen. Empty for none. */
export function ringLabel(action: { type: string; button?: string; count?: number }): string {
  switch (action.type) {
    case 'click':
      return action.button === 'right'
        ? 'Right-click'
        : (action.count ?? 1) === 2
          ? 'Double-click'
          : (action.count ?? 1) === 3
            ? 'Triple-click'
            : 'Click'
    case 'drag':
      return 'Drag from here'
    case 'scroll':
      return 'Scroll'
    default:
      return ''
  }
}

/** A window on screen, as the helper lists them front to back. */
export interface LaidWindow {
  /** The app it belongs to; null when nothing names it (the system's own). */
  app: { id: string; name: string } | null
  owner: string
  layer: number
  frame: ScreenArea
}

/** What a window is to a picture: shown, covered over, or not there at all. */
export type WindowPart = 'show' | 'hide' | 'skip'

/**
 * How a window is treated in a picture that shows only the apps the user
 * allowed. The Dock's window spans the display and is mostly nothing, as are
 * the screen-wide overlays some utilities keep: they neither show nor cover.
 * The menu bar is the system's and stays. Everything else belongs to an app,
 * and is covered unless that app was allowed.
 */
export function windowPart(
  w: LaidWindow,
  display: ScreenArea,
  allowed: (id: string) => boolean
): WindowPart {
  if (w.app?.id.toLowerCase() === 'com.apple.dock') return 'skip'
  if (!w.app) return w.owner === 'Window Server' ? 'show' : 'hide'
  if (allowed(w.app.id)) return 'show'
  const ordinary = w.layer === 0 || w.layer === 3 || w.layer === 8
  const spans =
    w.frame.x <= display.x &&
    w.frame.y <= display.y &&
    w.frame.x + w.frame.width >= display.x + display.width &&
    w.frame.y + w.frame.height >= display.y + display.height
  return !ordinary && spans ? 'skip' : 'hide'
}

/**
 * Covers, in a picture of a display, everything that is not a window of an
 * allowed app: other apps' windows, notifications, the desktop behind them.
 * `pixels` is four bytes a pixel and is changed in place. Returns the apps
 * that had something covered, front first.
 */
export function coverOthers(
  pixels: Uint8Array,
  shot: Shot,
  windows: LaidWindow[],
  allowed: (id: string) => boolean,
  grey = 0x2b
): string[] {
  const { width, height, area } = shot
  const k = width / area.width
  // 1 where the topmost thing is an allowed app's window. Back to front, so
  // each window overrules what it sits on.
  const keep = new Uint8Array(width * height)
  const hidden = new Map<string, true>()
  for (let i = windows.length - 1; i >= 0; i--) {
    const w = windows[i]
    const part = windowPart(w, area, allowed)
    if (part === 'skip') continue
    const x0 = Math.max(0, Math.floor((w.frame.x - area.x) * k))
    const y0 = Math.max(0, Math.floor((w.frame.y - area.y) * k))
    const x1 = Math.min(width, Math.ceil((w.frame.x + w.frame.width - area.x) * k))
    const y1 = Math.min(height, Math.ceil((w.frame.y + w.frame.height - area.y) * k))
    if (x1 <= x0 || y1 <= y0) continue
    const v = part === 'show' ? 1 : 0
    for (let y = y0; y < y1; y++) keep.fill(v, y * width + x0, y * width + x1)
  }
  // Named front first, and only those with something of theirs left covered.
  for (const w of windows) {
    if (!w.app || windowPart(w, area, allowed) !== 'hide' || hidden.has(w.app.name)) continue
    if (overlaps(w.frame, area)) hidden.set(w.app.name, true)
  }
  for (let i = 0; i < keep.length; i++) {
    if (keep[i]) continue
    const p = i * 4
    pixels[p] = pixels[p + 1] = pixels[p + 2] = grey
    pixels[p + 3] = 255
  }
  return [...hidden.keys()]
}
