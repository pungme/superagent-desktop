import { describe, expect, it } from 'vitest'
import { stepToward } from './animated-number'

describe('stepToward', () => {
  it('moves toward the target, never past it', () => {
    const next = stepToward(0, 100, 16)
    expect(next).toBeGreaterThan(0)
    expect(next).toBeLessThan(100)
  })

  it('snaps once within 1 of the target', () => {
    expect(stepToward(99.6, 100, 16)).toBe(100)
  })

  it('is frame-rate independent — a bigger dt closes more of the gap', () => {
    const small = stepToward(0, 100, 16)
    const big = stepToward(0, 100, 100)
    expect(big).toBeGreaterThan(small)
  })

  it('handles a target below the current value the same way (closes the gap)', () => {
    const next = stepToward(100, 0, 16)
    expect(next).toBeLessThan(100)
    expect(next).toBeGreaterThan(0)
  })
})
