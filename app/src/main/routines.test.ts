import { describe, it, expect } from 'vitest'
import { flooredInterval, MIN_INTERVAL_MS } from './routines'

describe('flooredInterval', () => {
  it('raises a sub-hour interval to the 60-minute floor', () => {
    expect(flooredInterval(5 * 60 * 1000)).toBe(MIN_INTERVAL_MS)
    expect(flooredInterval(0)).toBe(MIN_INTERVAL_MS)
  })

  it('keeps an interval at or above the floor unchanged', () => {
    expect(flooredInterval(MIN_INTERVAL_MS)).toBe(MIN_INTERVAL_MS)
    expect(flooredInterval(2 * MIN_INTERVAL_MS)).toBe(2 * MIN_INTERVAL_MS)
  })
})
