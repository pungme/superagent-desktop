import { describe, expect, it } from 'vitest'
import {
  CONSENT_IDLE_MS,
  consentStands,
  shotSize,
  toScreenPoint,
  validKeyCombo
} from './computer-use'

const laptop = { x: 0, y: 0, width: 1728, height: 1117 }
const second = { x: 1728, y: -200, width: 2560, height: 1440 }

describe('the screenshot the agent is given', () => {
  it('is the display at its own size when that is small enough', () => {
    expect(shotSize({ x: 0, y: 0, width: 1280, height: 800 })).toEqual({ width: 1280, height: 800 })
  })
  it('is scaled down to the cap, keeping its shape, and never up', () => {
    const s = shotSize(second)
    expect(s.width).toBe(1440)
    expect(s.height).toBe(810)
    expect(shotSize(laptop).width).toBe(1440)
  })
})

describe('a point on the screenshot, on the screen', () => {
  const shot = { ...shotSize(laptop), area: laptop }
  it('scales back up to the display', () => {
    expect(toScreenPoint(shot, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(toScreenPoint(shot, 720, 465)).toEqual({ x: 864, y: 558 })
    expect(toScreenPoint(shot, shot.width, shot.height)).toEqual({ x: 1728, y: 1117 })
  })
  it('lands on the second display when that is the one photographed', () => {
    const far = { ...shotSize(second), area: second }
    expect(toScreenPoint(far, 0, 0)).toEqual({ x: 1728, y: -200 })
    expect(toScreenPoint(far, 720, 405)).toEqual({ x: 3008, y: 520 })
  })
  it('refuses a point that is not on the picture', () => {
    expect(toScreenPoint(shot, -1, 10)).toBeNull()
    expect(toScreenPoint(shot, 10, shot.height + 1)).toBeNull()
    expect(toScreenPoint(shot, Number.NaN, 10)).toBeNull()
  })
})

it('accepts key combinations that are modifiers and one key, and nothing else', () => {
  for (const ok of ['a', 'return', 'cmd+c', 'cmd+shift+4', 'ctrl+alt+delete', 'cmd+,', 'f5'])
    expect(validKeyCombo(ok), ok).toBe(true)
  for (const bad of ['', 'cmd+', 'cmd+a+b c', 'cmd+shift', 'a; rm -rf', 'cmd +c'])
    expect(validKeyCombo(bad), bad).toBe(false)
})

it("keeps a yes while the agent keeps working, and lets it lapse when it doesn't", () => {
  expect(consentStands(undefined, 1000)).toBe(false)
  expect(consentStands(1000, 1000 + CONSENT_IDLE_MS - 1)).toBe(true)
  expect(consentStands(1000, 1000 + CONSENT_IDLE_MS)).toBe(false)
})
