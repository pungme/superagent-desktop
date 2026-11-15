import { describe, it, expect } from 'vitest'
import { bringOnto, offScreen, visibleArea } from './on-screen'

const main = { x: 0, y: 0, width: 1728, height: 1080 }

describe('offScreen', () => {
  it('leaves a window on a display alone', () => {
    expect(offScreen({ x: 100, y: 80, width: 1280, height: 800 }, [main])).toBe(false)
    // Half off the edge is still reachable.
    expect(offScreen({ x: 1000, y: 80, width: 1280, height: 800 }, [main])).toBe(false)
  })
  it('catches one left on a display that went away', () => {
    expect(offScreen({ x: 2400, y: 100, width: 1280, height: 800 }, [main])).toBe(true)
    expect(offScreen({ x: 1720, y: 1070, width: 1280, height: 800 }, [main])).toBe(true)
  })
  it('says nothing when no display is known', () => {
    expect(offScreen({ x: 9999, y: 0, width: 100, height: 100 }, [])).toBe(false)
  })
  it('counts every display', () => {
    const two = [main, { x: 1728, y: 0, width: 1920, height: 1080 }]
    expect(visibleArea({ x: 1700, y: 0, width: 100, height: 100 }, two)).toBe(10000)
    expect(offScreen({ x: 2400, y: 100, width: 1280, height: 800 }, two)).toBe(false)
  })
})

describe('bringOnto', () => {
  it('centres it, and never larger than the display', () => {
    expect(bringOnto({ x: 2400, y: 100, width: 1280, height: 800 }, main)).toEqual({
      x: 224,
      y: 140,
      width: 1280,
      height: 800
    })
    expect(bringOnto({ x: 0, y: 0, width: 3000, height: 2000 }, main)).toEqual({
      x: 0,
      y: 0,
      width: 1728,
      height: 1080
    })
  })
})
