import { describe, it, expect } from 'vitest'
import { GLYPH_SIZE, trayGlyph } from './tray-glyph'

/** Alpha at a point of the 32×32 glyph, 0–255. */
const alpha = (buf: Buffer, x: number, y: number): number => buf[(y * GLYPH_SIZE + x) * 4 + 3]
const inked = (buf: Buffer): number => {
  let n = 0
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) n++
  return n
}

/**
 * The icon was once an SVG that nativeImage could not read: an empty image,
 * an invisible menu bar item. These hold the drawing to something visible.
 */
describe('trayGlyph', () => {
  it('draws something in every state', () => {
    for (const state of ['idle', 'working', 'needs-you'] as const) {
      const g = trayGlyph(state, true)
      expect(g.length).toBe(GLYPH_SIZE * GLYPH_SIZE * 4)
      expect(inked(g)).toBeGreaterThan(80)
    }
  })

  it('is black, so macOS can tint it as a template', () => {
    const g = trayGlyph('working', true)
    for (let i = 0; i < g.length; i += 4) expect(g[i] + g[i + 1] + g[i + 2]).toBe(0)
  })

  it('has the mark’s outline down its left side, and its solid middle', () => {
    expect(alpha(trayGlyph('idle', true), 3, 16)).toBeGreaterThan(200)
    expect(alpha(trayGlyph('idle', true), 16, 16)).toBeGreaterThan(200)
    // Between the two: clear.
    expect(alpha(trayGlyph('idle', true), 8, 16)).toBe(0)
  })

  it('breathes while working: the middle square changes size between frames', () => {
    const a = trayGlyph('working', true, 0)
    const b = trayGlyph('working', true, 1)
    expect(a.equals(b)).toBe(false)
    expect(alpha(a, 11, 16)).toBeGreaterThan(alpha(b, 11, 16))
  })

  it('shows a dot in the corner only when a chat needs you', () => {
    expect(alpha(trayGlyph('idle', true), 26, 6)).toBe(0)
    expect(alpha(trayGlyph('working', true), 26, 6)).toBe(0)
    expect(alpha(trayGlyph('needs-you', true), 26, 6)).toBeGreaterThan(200)
  })

  it('fades the mark when the relay is not connected', () => {
    expect(alpha(trayGlyph('idle', false), 3, 16)).toBeLessThan(
      alpha(trayGlyph('idle', true), 3, 16)
    )
  })
})
