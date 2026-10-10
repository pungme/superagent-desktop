import { describe, expect, it } from 'vitest'
import { dotBounds, DOT_H, DOT_W } from './dot-bounds'

const laptop = { x: 0, y: 25, width: 1728, height: 1092 }
const monitor = { x: 1728, y: 0, width: 2560, height: 1440 }

describe("where the dot's window goes", () => {
  it('starts in the bottom-right corner of the main screen', () => {
    expect(dotBounds(null, [laptop], laptop)).toEqual({
      x: 1728 - DOT_W,
      y: 25 + 1092 - DOT_H,
      width: DOT_W,
      height: DOT_H
    })
  })

  it('stays where it was dragged to, on either screen', () => {
    expect(dotBounds({ x: 300, y: 200 }, [laptop, monitor], laptop)).toMatchObject({
      x: 300,
      y: 200
    })
    expect(dotBounds({ x: 3000, y: 400 }, [laptop, monitor], laptop)).toMatchObject({
      x: 3000,
      y: 400
    })
  })

  /** Left on a monitor that has since been unplugged. */
  it('comes back to the main screen when its screen is gone', () => {
    expect(dotBounds({ x: 3000, y: 400 }, [laptop], laptop)).toMatchObject({
      x: 1728 - DOT_W,
      y: 25 + 1092 - DOT_H
    })
  })

  it('comes back when only part of the tile would be on screen', () => {
    // The window mostly on, but its tile hanging off the bottom edge.
    expect(dotBounds({ x: 900, y: 1092 - DOT_H + 60 }, [laptop], laptop).y).toBe(25 + 1092 - DOT_H)
  })

  it('may hang its empty part off a screen, as long as the tile is on it', () => {
    // Dragged to the top-left: the window is half off, the tile is not.
    const far = { x: -(DOT_W - 80), y: 25 - (DOT_H - 80) }
    expect(dotBounds(far, [laptop], laptop)).toMatchObject(far)
  })
})

describe('whether a point is on the dot', () => {
  const b = { x: 1000, y: 400, width: 420, height: 620 }
  it('is only the tile in the corner while the panel is closed', async () => {
    const { pointOnDot } = await import('./dot-bounds')
    expect(pointOnDot(b, false, 1400, 1000)).toBe(true)
    // The rest of its window is see-through: what is under it can be clicked.
    expect(pointOnDot(b, false, 1100, 500)).toBe(false)
    expect(pointOnDot(b, false, 500, 500)).toBe(false)
  })
  it('is the whole window while the panel is open, and nothing outside it', async () => {
    const { pointOnDot } = await import('./dot-bounds')
    expect(pointOnDot(b, true, 1100, 500)).toBe(true)
    expect(pointOnDot(b, true, 999, 500)).toBe(false)
    expect(pointOnDot(b, true, 1100, 1020)).toBe(false)
  })
})
