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

/** How long a yes to "let it use this Mac" lasts without the agent doing anything. */
export const CONSENT_IDLE_MS = 10 * 60_000

/** Whether an earlier yes still stands: it does while the agent keeps working. */
export function consentStands(lastUsedAt: number | undefined, now: number): boolean {
  return lastUsedAt !== undefined && now - lastUsedAt < CONSENT_IDLE_MS
}

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
