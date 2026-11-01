import { COMPUTER_STOP_HOTKEY, normalKeyCombo, type ScreenArea } from './computer-use'

/**
 * Remote control, the parts that are only rules and arithmetic: how long things
 * last, which keys the phone may press, where a point on the phone's picture is
 * on the Mac, and the small counters that keep a stolen or runaway phone slow.
 * main/remote-control/ holds the part that touches the Mac.
 *
 * Shared between main and tests; no Electron or Node imports.
 */

/** No input for this long and the session ends; the next one has to be allowed at the Mac again. */
export const REMOTE_IDLE_MS = 10 * 60_000
/** However busy, one session ends after this long. */
export const REMOTE_MAX_MS = 2 * 60 * 60_000
/**
 * The phone has not said a word (input, a view update, a ping) for this long:
 * it is gone. Phones ping every 25 seconds and send a view update every few
 * while the screen is up; a socket that died without a close is noticed here,
 * since the relay itself waits 100 seconds.
 */
export const REMOTE_SILENT_MS = 45_000
/** From the request to the end of the code step: the whole ask expires after this. */
export const REMOTE_ASK_MS = 120_000
/** Wrong codes allowed per request. */
export const REMOTE_CODE_TRIES = 3
/** The soonest a phone may ask again after it last asked. */
export const REMOTE_MIN_GAP_MS = 5_000
/** This many refusals (denied, expired, wrong code) inside the window lock requests out. */
export const REMOTE_STRIKES = 3
export const REMOTE_STRIKE_WINDOW_MS = 10 * 60_000
export const REMOTE_LOCKOUT_MS = 10 * 60_000
/**
 * Dialogs one phone may pop up at the Mac per hour, counting the ones cancelled
 * by a disconnect: a hostile phone cannot keep stealing focus with a new one.
 */
export const REMOTE_ASKS_PER_HOUR = 6
export const REMOTE_ASK_WINDOW_MS = 60 * 60_000
/** What each guarded step costs the rate limit: the Mac is asked what is in front (two processes), the helper runs (one). */
export const SPAWNS_FRONT = 2
export const SPAWNS_HELPER = 1
export const SPAWNS_AT = 1
/** The bucket every action is charged to, a token per process started. */
export const REMOTE_BUCKET_RATE = 80
export const REMOTE_BUCKET_BURST = 80
/** Typed characters a second, and at once: a full 500-character text is allowed, then it waits. */
export const REMOTE_TEXT_RATE = 250
export const REMOTE_TEXT_BURST = 500
/** After a click or a key that can change the app in front, the Mac gets this long to do it before the next action looks. */
export const REMOTE_SETTLE_MS = 250
/** Between the readings of the app in front while it settles. */
export const REMOTE_SETTLE_STEP_MS = 150
/** After Return in Spotlight or another launcher: the app it opens takes its time. */
export const REMOTE_LAUNCH_SETTLE_MS = 1200
/** Readings (two processes each) a settle may take before it says it did not settle. */
export const REMOTE_SETTLE_READS = 6

/**
 * The most a picture may be, as JPEG bytes. A relay frame is at most 1,048,576
 * characters, and what is sent is base64 of the sealed JSON, which holds the
 * JPEG as base64: 4/3 twice over. 540,000 bytes of JPEG seals to about 960,000
 * characters, with room left for the rest of the frame (see the test that
 * seals one).
 */
export const REMOTE_FRAME_JPEG_MAX = 540_000

// --- keys --------------------------------------------------------------------

export const REMOTE_MODS = ['cmd', 'shift', 'opt', 'ctrl', 'fn'] as const
export type RemoteMod = (typeof REMOTE_MODS)[number]

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('')
const DIGITS = '0123456789'.split('')
const MARKS = ['=', '-', '[', ']', "'", ';', '\\', ',', '/', '.', '`']
const NAMED = [
  'return',
  'tab',
  'space',
  'delete',
  'forwarddelete',
  'escape',
  'left',
  'right',
  'up',
  'down',
  'home',
  'end',
  'pageup',
  'pagedown',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)
]

/** Every key the phone may press (the helper's own names), and no others. */
export const REMOTE_KEYS: readonly string[] = [...LETTERS, ...DIGITS, ...MARKS, ...NAMED]

/** Superagent's own shortcuts, whatever spelling Electron's accelerators use, as a combo. */
function ownCombo(accelerator: string): string {
  return normalKeyCombo(
    accelerator
      .replace(/commandorcontrol|cmdorctrl|command|cmd|super|meta/gi, 'cmd')
      .replace(/control|ctrl/gi, 'ctrl')
      .replace(/option|alt/gi, 'opt')
  )
}

export type KeyVerdict = { ok: true; combo: string } | { ok: false; why: string }

/**
 * Whether the phone may press this, and the combo to hand the helper. Refused:
 * a key that is not in the list; the shortcut that stops remote control and
 * computer use (⌥Esc); anything with Escape and Option or Command in it, which
 * is how Force Quit opens (⌘⌥Esc); the shortcuts that log the user out (⇧⌘Q,
 * ⌥⇧⌘Q), which would close Superagent and with it the session; and each of
 * Superagent's own shortcuts (`own`), which would open its windows.
 */
export function remoteKey(
  key: string,
  mods: readonly string[] = [],
  own: string[] = []
): KeyVerdict {
  const k = key.toLowerCase()
  if (!REMOTE_KEYS.includes(k))
    return { ok: false, why: 'that key is not one remote control presses' }
  if (!mods.every((m) => (REMOTE_MODS as readonly string[]).includes(m)))
    return { ok: false, why: 'that modifier is not one remote control presses' }
  const set = new Set(mods)
  const combo = [...[...set].sort(), k].join('+')
  const norm = normalKeyCombo(combo)
  if (norm === normalKeyCombo(COMPUTER_STOP_HOTKEY))
    return { ok: false, why: 'that is the shortcut that stops remote control' }
  if (k === 'escape' && (set.has('opt') || set.has('cmd')))
    return { ok: false, why: 'that opens Force Quit, which remote control does not press' }
  if (k === 'q' && set.has('cmd') && (set.has('shift') || set.has('opt')))
    return { ok: false, why: 'that logs the Mac out, which would end the session' }
  if (own.some((a) => a && ownCombo(a) === norm))
    return { ok: false, why: "that is one of Superagent's own shortcuts" }
  return { ok: true, combo }
}

/** Text the phone types: printable characters only (Return, Tab and the rest are keys). */
export function remoteTextOk(text: string): boolean {
  // eslint-disable-next-line no-control-regex
  return text.length > 0 && text.length <= 500 && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(text)
}

// --- points ------------------------------------------------------------------

/**
 * A point on the phone's picture (0..1 across and down) as a point on the Mac,
 * in the system's own coordinates. The picture is the whole shared display, so
 * it is a straight scale whatever the display's size or scale factor; and held
 * inside the display, so no point the phone can name is on another one.
 */
export function remotePoint(area: ScreenArea, fx: number, fy: number): { x: number; y: number } {
  const unit = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)
  return {
    x: area.x + Math.min(area.width - 1, Math.floor(unit(fx) * area.width)),
    y: area.y + Math.min(area.height - 1, Math.floor(unit(fy) * area.height))
  }
}

/** Where the Mac's pointer is on the picture, or null when it is on another display. */
export function cursorOnPicture(
  area: ScreenArea,
  at: { x: number; y: number }
): { x: number; y: number } | null {
  if (at.x < area.x || at.y < area.y || at.x >= area.x + area.width || at.y >= area.y + area.height)
    return null
  return { x: (at.x - area.x) / area.width, y: (at.y - area.y) / area.height }
}

/** A finger's scroll (fractions of the picture) as pixels, held to what a flick can be. */
export function scrollPixels(area: ScreenArea, dx: number, dy: number): { dx: number; dy: number } {
  const px = (v: number, of: number): number => Math.max(-3000, Math.min(3000, Math.round(v * of)))
  return { dx: px(dx, area.width), dy: px(dy, area.height) }
}

// --- counters ----------------------------------------------------------------

/** A token bucket: `rate` a second, `burst` at once. The clock is passed in. */
export class TokenBucket {
  private tokens: number
  private at: number
  constructor(
    private rate: number,
    private burst: number,
    now: number
  ) {
    this.tokens = burst
    this.at = now
  }
  take(cost: number, now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.rate)
    this.at = now
    if (this.tokens < cost) return false
    this.tokens -= cost
    return true
  }
}

/** The code the Mac shows: six digits. `below(n)` is a random integer in [0, n). */
export function newCode(below: (n: number) => number): string {
  return String(below(1_000_000)).padStart(6, '0')
}

/**
 * A phone's name as the Allow dialog shows it: no control, format (bidi
 * overrides, zero width), line or paragraph separator characters, single
 * spaces, at most 60 characters. Shown after a fixed prefix, never alone.
 */
export function cleanDeviceName(name: string): string {
  const out = Array.from(
    name
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]/gu, ' ')
      .replace(/\s+/gu, ' ')
      .trim()
  )
    .slice(0, 60)
    .join('')
    .trim()
  return out || 'a phone'
}

/**
 * The Allow dialog's words: what the phone can and cannot do, plainly. `shells`:
 * whether Superagent was told at the Mac that a phone may use terminals and
 * scripting apps.
 */
export function allowDialog(
  deviceName: string,
  shells: boolean
): { message: string; detail: string } {
  return {
    message: 'Allow a phone to control this Mac?',
    detail: [
      `Paired phone: ${deviceName}`,
      'It will see everything on this screen and use the mouse and keyboard until you press ⌥Esc or choose Stop in the red bar.',
      "It is kept out of Superagent's windows, password managers and the lock screen. Any other app, such as your mail or browser, it can use as you.",
      shells
        ? 'You allowed terminals and scripting apps, so it can run commands as you.'
        : 'Terminals and scripting apps are blocked.',
      'Only allow it if you just asked for this on your phone.'
    ].join('\n\n')
  }
}

/** Asks inside the hour; null when another may be made, else when the oldest one stops counting. */
export function askBudgetLeftAt(asks: number[], now: number): number | null {
  const recent = asks.filter((t) => now - t < REMOTE_ASK_WINDOW_MS)
  if (recent.length < REMOTE_ASKS_PER_HOUR) return null
  return Math.min(...recent) + REMOTE_ASK_WINDOW_MS
}

/**
 * Whether a test run asked for no windows (`COVE_E2E_QUIET=1`). Never in a
 * packaged app: anything that can set the app's environment (a LaunchAgent,
 * `launchctl setenv`) would otherwise turn the banner off while input works.
 */
export function quietRun(env: Record<string, string | undefined>, packaged: boolean): boolean {
  return !packaged && env.COVE_E2E_QUIET === '1'
}

/** Equal without stopping at the first difference. */
export function sameCode(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/** "482 913", as the dialog shows it. */
export function spacedCode(code: string): string {
  return `${code.slice(0, 3)} ${code.slice(3)}`
}

/** Strikes inside the window; locked out once there are enough. Returns when the lock lifts, or null. */
export function lockedUntil(strikes: number[], now: number): number | null {
  const recent = strikes.filter((t) => now - t < REMOTE_STRIKE_WINDOW_MS)
  if (recent.length < REMOTE_STRIKES) return null
  const lifts = Math.max(...recent) + REMOTE_LOCKOUT_MS
  return lifts > now ? lifts : null
}
