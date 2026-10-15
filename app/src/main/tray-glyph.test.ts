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

  it('has the phone’s outline down its left side', () => {
    expect(alpha(trayGlyph('idle', true), 9, 16)).toBeGreaterThan(200)
  })

  it('shows a dot only when something is going on', () => {
    // Up and right of the phone's corner: only the dot is ever drawn here.
    expect(alpha(trayGlyph('idle', true), 27, 5)).toBe(0)
    expect(alpha(trayGlyph('working', true), 27, 5)).toBeGreaterThan(200)
  })

  it('breathes while working: the two frames differ', () => {
    expect(trayGlyph('working', true, 0).equals(trayGlyph('working', true, 1))).toBe(false)
  })

  it('rings the dot when it needs you, so it is not the working dot', () => {
    const g = trayGlyph('needs-you', true)
    expect(alpha(g, 24, 8)).toBe(0) // the hole
    expect(alpha(g, 28, 8)).toBeGreaterThan(200) // the ring
  })

  it('fades the phone when the relay is not connected', () => {
    expect(alpha(trayGlyph('idle', false), 9, 16)).toBeLessThan(
      alpha(trayGlyph('idle', true), 9, 16)
    )
  })
})
