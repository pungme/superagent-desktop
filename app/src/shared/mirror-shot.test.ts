import { describe, expect, it } from 'vitest'
import { mirrorShotWidth } from './mirror-shot'

describe("how wide the phone's picture of a page is", () => {
  it('is 700 unless more is asked for, and never past 1400', () => {
    expect(mirrorShotWidth(undefined)).toBe(700)
    expect(mirrorShotWidth(700)).toBe(700)
    expect(mirrorShotWidth(1400)).toBe(1400)
    expect(mirrorShotWidth(1600)).toBe(1400)
    expect(mirrorShotWidth(50)).toBe(200)
    expect(mirrorShotWidth(NaN)).toBe(700)
  })
})
