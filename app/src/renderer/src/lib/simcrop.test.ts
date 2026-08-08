import { describe, expect, it } from 'vitest'
import { screenCrop } from '../components/SimulatorPane'

describe('screenCrop', () => {
  it('finds the title bar on a captured iPhone window', () => {
    // iPhone 16: 393x852 points. A window showing it at 1x plus a 28pt bar.
    expect(Math.round(screenCrop(393, 880, 393, 852, false))).toBe(28)
  })

  it('is scale-independent — a Retina capture crops proportionally', () => {
    expect(Math.round(screenCrop(786, 1760, 393, 852, false))).toBe(56)
  })

  it('crops nothing when bezels are on, since the screen inset is unknowable', () => {
    expect(screenCrop(393, 880, 393, 852, true)).toBe(0)
  })

  it('crops nothing rather than something negative when the window is too short', () => {
    expect(screenCrop(393, 100, 393, 852, false)).toBe(0)
    expect(screenCrop(0, 0, 393, 852, false)).toBe(0)
    expect(screenCrop(393, 880, 0, 0, false)).toBe(0)
  })

  it('never crops the whole frame away', () => {
    // A device reported as absurdly wide would otherwise crop away every row.
    expect(screenCrop(393, 880, 852, 1, false)).toBe(879)
  })

  it('leaves a window that is exactly the screen uncropped', () => {
    expect(Math.round(screenCrop(393, 852, 393, 852, false))).toBe(0)
  })
})
