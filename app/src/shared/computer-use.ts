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
