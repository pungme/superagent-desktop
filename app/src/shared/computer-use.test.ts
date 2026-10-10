import { describe, expect, it } from 'vitest'
import {
  CONSENT_IDLE_MS,
  consentStands,
  bundleIdFrom,
  focusMoved,
  offLimitsApp,
  pointerMoved,
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

describe('apps computer use stays out of', () => {
  it('names the password managers and the lock screen, and their helper apps', () => {
    expect(offLimitsApp('com.1password.1password')).toBe('1Password')
    expect(offLimitsApp('com.1password.1password-launcher')).toBe('1Password')
    expect(offLimitsApp('com.apple.Passwords')).toBe('Passwords')
    expect(offLimitsApp('com.apple.keychainaccess')).toBe('Keychain Access')
    expect(offLimitsApp('com.bitwarden.desktop')).toBe('Bitwarden')
    expect(offLimitsApp('com.apple.loginwindow')).toBe('the lock screen')
    expect(offLimitsApp('COM.APPLE.LOGINWINDOW')).toBe('the lock screen')
  })
  it('lets every other app through, and an unknown one', () => {
    for (const ok of ['com.apple.finder', 'com.figma.Desktop', 'com.apple.Safari', '', null])
      expect(offLimitsApp(ok), String(ok)).toBeNull()
    // Not fooled by a name that merely contains one.
    expect(offLimitsApp('com.example.com.1password.notes')).toBeNull()
  })
  it('reads the bundle id out of what macOS prints', () => {
    expect(
      bundleIdFrom('[ NULL ]  ASN:0x0-0x1001: (in front) \n    bundleID="com.apple.loginwindow"')
    ).toBe('com.apple.loginwindow')
    expect(bundleIdFrom('bundleID=[ NULL ]')).toBeNull()
    expect(bundleIdFrom('')).toBeNull()
  })
})

describe('whether focus moved since the last look', () => {
  it('is yes only when both are known and differ', () => {
    expect(focusMoved('com.apple.TextEdit', 'com.apple.Safari')).toBe(true)
    expect(focusMoved('com.apple.TextEdit', 'com.apple.textedit')).toBe(false)
    expect(focusMoved(undefined, 'com.apple.Safari')).toBe(false)
    expect(focusMoved('com.apple.TextEdit', null)).toBe(false)
  })
})

describe('whether the user has moved the mouse', () => {
  it('ignores a wobble and not knowing, and sees a real move', () => {
    expect(pointerMoved({ x: 100, y: 100 }, { x: 103, y: 102 })).toBe(false)
    expect(pointerMoved({ x: 100, y: 100 }, { x: 140, y: 100 })).toBe(true)
    expect(pointerMoved(undefined, { x: 1, y: 1 })).toBe(false)
    expect(pointerMoved({ x: 1, y: 1 }, null)).toBe(false)
  })
})
