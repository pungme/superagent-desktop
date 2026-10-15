/**
 * The menu bar icon: the Superagent mark, drawn as pixels.
 *
 * It used to be a phone drawn as an SVG handed to nativeImage, which cannot
 * read SVG: the image came back empty, and the menu bar item was a blank,
 * clickable gap. This draws the app's own mark (a rounded square around a
 * smaller solid one, as on the app icon) straight into a bitmap, anti-aliased,
 * at 32×32 for a 16pt Retina item.
 *
 * Black with alpha only, because it is a template image: macOS tints it white
 * or black to suit the menu bar. State shows in the mark itself:
 *
 *   idle       the mark
 *   working    the inner square breathes (two frames)
 *   needs-you  a dot in the corner, set into the outline
 *   unlinked   the mark faded: the relay is not connected
 */

export type TrayState = 'idle' | 'working' | 'needs-you'

export const GLYPH_SIZE = 32

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Distance from (px,py) to a rounded rectangle's edge: negative inside. */
function roundedRectSdf(
  px: number,
  py: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  r: number
): number {
  const qx = Math.abs(px - cx) - (hw - r)
  const qy = Math.abs(py - cy) - (hh - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

/**
 * The icon's pixels: BGRA, premultiplied (black, so only alpha carries
 * anything), GLYPH_SIZE square. `frame` alternates the breathing dot.
 */
export function trayGlyph(state: TrayState, linked: boolean, frame = 0): Buffer {
  const n = GLYPH_SIZE
  const buf = Buffer.alloc(n * n * 4)
  // The inner square: the app icon's proportions; a breath smaller on the
  // working beat.
  const inner = state === 'working' && frame % 2 ? 4.2 : 5.4
  const dot = state === 'needs-you' ? { x: 26, y: 6, r: 5 } : null
  const gap = 2
  const strength = linked ? 1 : 0.45
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5
      const py = y + 0.5
      // The outer rounded square, as an outline (stroke 2.4).
      const d = roundedRectSdf(px, py, 16, 16, 13, 13, 6)
      let a = clamp01(0.5 - (Math.abs(d) - 1.2))
      // The solid square in the middle.
      const c = roundedRectSdf(px, py, 16, 16, inner, inner, inner * 0.42)
      a = Math.max(a, clamp01(0.5 - c))
      if (dot) {
        const dd = Math.hypot(px - dot.x, py - dot.y)
        // Cut the mark away around the dot, then the dot itself.
        a *= clamp01(dd - (dot.r + gap) + 0.5)
        a = Math.max(a, clamp01(dot.r - dd + 0.5))
      }
      a *= strength
      const i = (y * n + x) * 4
      // BGRA; black, premultiplied, so colour stays 0 and only alpha is set.
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return buf
}
