import { describe, expect, it } from 'vitest'
import { CENTRED, clampPlace, pictureRect } from './app-icon'

describe('where a picture sits in the app icon', () => {
  it('covers the icon when centred, whatever its shape', () => {
    // A wide picture: as tall as the box, spilling over at the sides.
    const wide = pictureRect(2000, 1000, 1024, 824, CENTRED)
    expect(wide.h).toBeCloseTo(824)
    expect(wide.w).toBeCloseTo(1648)
    expect(wide.x).toBeCloseTo((1024 - 1648) / 2)
    expect(wide.panX).toBeCloseTo(412)
    expect(wide.panY).toBeCloseTo(0)
  })

  it('never shows an edge, however far it is slid', () => {
    const box = 824
    const edge = (1024 - box) / 2
    for (const place of [
      { zoom: 1, x: 1, y: 1 },
      { zoom: 1, x: -1, y: -1 },
      { zoom: 2.5, x: 1, y: -1 }
    ]) {
      const r = pictureRect(1200, 1600, 1024, box, place)
      expect(r.x).toBeLessThanOrEqual(edge + 1e-6)
      expect(r.y).toBeLessThanOrEqual(edge + 1e-6)
      expect(r.x + r.w).toBeGreaterThanOrEqual(edge + box - 1e-6)
      expect(r.y + r.h).toBeGreaterThanOrEqual(edge + box - 1e-6)
    }
  })

  it('keeps a saved placement within bounds, and survives rubbish', () => {
    expect(clampPlace({ zoom: 99, x: -7, y: 0.25 })).toEqual({ zoom: 5, x: -1, y: 0.25 })
    expect(clampPlace(null)).toEqual(CENTRED)
    expect(clampPlace({ zoom: Number.NaN } as never)).toEqual(CENTRED)
  })
})
