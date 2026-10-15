/**
 * The menu bar icon, drawn as pixels.
 *
 * It used to be an SVG handed to nativeImage, which cannot read SVG: the
 * image came back empty, and the menu bar item was a blank, clickable gap with
 * nothing to see — no phone, no dot. This draws the same phone directly into a
 * bitmap, anti-aliased, at 32×32 for a 16pt Retina item.
 *
 * Black with alpha only, because it is a template image: macOS tints it white
 * or black to suit the menu bar, which a coloured icon could not do (a dark
 * outline vanished on a dark menu bar). State shows in the shape instead:
 *
 *   idle       the phone
 *   working    the phone and a dot in its corner, breathing (two frames)
 *   needs-you  the phone and a larger dot, ringed, held still
 *   unlinked   the phone faded: the relay is not connected
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
  const dot =
    state === 'working'
      ? { x: 24, y: 8, r: frame % 2 ? 4.2 : 5.2 }
      : state === 'needs-you'
        ? { x: 24, y: 8, r: 5.6 }
        : null
  // The phone stands back from the dot by a clear gap, so the two read apart.
  const gap = 2.2
  const strength = linked ? 1 : 0.45
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const px = x + 0.5
      const py = y + 0.5
      // The phone: a rounded outline, 14×26, stroke 2.5.
      const d = roundedRectSdf(px, py, 16, 16, 7, 13, 3.5)
      let a = clamp01(0.5 - (Math.abs(d) - 1.25))
      // Its home bar.
      const bar = roundedRectSdf(px, py, 16, 25, 3, 1, 1)
      a = Math.max(a, clamp01(0.5 - bar))
      if (dot) {
        const dd = Math.hypot(px - dot.x, py - dot.y)
        // Cut the phone away around the dot…
        a *= clamp01(dd - (dot.r + gap) + 0.5)
        // …then the dot itself.
        let da = clamp01(dot.r - dd + 0.5)
        // Needs you: a ring around the dot, so it is not the working dot held still.
        if (state === 'needs-you') da = clamp01(dot.r - dd + 0.5) * clamp01(dd - 2.3 + 0.5)
        a = Math.max(a, da)
      }
      a *= strength
      const i = (y * n + x) * 4
      // BGRA; black, premultiplied, so colour stays 0 and only alpha is set.
      buf[i + 3] = Math.round(a * 255)
    }
  }
  return buf
}
