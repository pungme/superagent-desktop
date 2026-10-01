import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  baguetteCandidates,
  escapeForAppleScript,
  navigationReplacesPage,
  simulatorScreenPoint,
  usesPersistentSimSession,
  orientationFrom,
  parseScreens,
  postureAngle
} from './simulator'

/**
 * A simulator stream belongs to the page that asked for it. Getting this
 * predicate wrong is expensive in both directions: too eager and a live
 * simulator blanks mid-session, too lax and the helper decodes frames for a
 * pane that no longer exists.
 */
describe('navigationReplacesPage', () => {
  it('is true for a reload or any other main-frame load', () => {
    expect(navigationReplacesPage({ isMainFrame: true, isSameDocument: false })).toBe(true)
  })

  it('is false for same-document navigation — the pane is still there', () => {
    // A hash or history change leaves the renderer, and the pane, untouched.
    expect(navigationReplacesPage({ isMainFrame: true, isSameDocument: true })).toBe(false)
  })

  it('is false for a subframe, which is some other page entirely', () => {
    expect(navigationReplacesPage({ isMainFrame: false, isSameDocument: false })).toBe(false)
    expect(navigationReplacesPage({ isMainFrame: false, isSameDocument: true })).toBe(false)
  })
})

/**
 * Tapping must work out of the box, so the copy the app ships with has to be
 * found before any brew install — and the brew paths must still be there for a
 * build that lacks it.
 */
describe('baguetteCandidates', () => {
  it('tries the bundled copy in Resources first in a packaged app', () => {
    const c = baguetteCandidates(true, '/Applications/SuperAgent.app/Contents/Resources')
    expect(c[0]).toBe('/Applications/SuperAgent.app/Contents/Resources/baguette')
    expect(c.slice(-2)).toEqual(['/opt/homebrew/bin/baguette', '/usr/local/bin/baguette'])
  })

  it('tries native/baguette first in development', () => {
    const c = baguetteCandidates(false, '/unused')
    expect(c[0].endsWith('/native/baguette')).toBe(true)
    expect(c).toContain('/opt/homebrew/bin/baguette')
  })
})

/**
 * A device name drops straight into an AppleScript `windows whose name
 * contains "…"` string. Two or more conversations can each have their own
 * device booted in the same Simulator.app process, so this is what keeps
 * hiding your own device's window (see hideSimulatorApp) from also touching
 * someone else's — get the escaping wrong and a name with a quote in it
 * either breaks the script or, worse, matches every window instead of one.
 */
describe('escapeForAppleScript', () => {
  it('leaves an ordinary device name alone', () => {
    expect(escapeForAppleScript('iPhone 17 Pro')).toBe('iPhone 17 Pro')
  })

  it('escapes a double quote so it cannot close the string early', () => {
    expect(escapeForAppleScript('My "Weird" iPhone')).toBe('My \\"Weird\\" iPhone')
  })

  it('escapes a backslash so it is not read as an escape sequence', () => {
    expect(escapeForAppleScript('back\\slash')).toBe('back\\\\slash')
  })
})

describe('simulatorScreenPoint', () => {
  it('leaves portrait screenshot coordinates unchanged', () => {
    expect(simulatorScreenPoint(300, 700, 1640, 2360)).toEqual({
      x: 300,
      y: 700,
      width: 1640,
      height: 2360
    })
  })

  it('unwinds a landscape screenshot onto the portrait HID surface', () => {
    expect(simulatorScreenPoint(1180, 630, 2360, 1640)).toEqual({
      x: 630,
      y: 1180,
      width: 1640,
      height: 2360
    })
  })
})

describe('usesPersistentSimSession', () => {
  const tap = { type: 'tap' as const }

  it('keeps the low-latency session for interactive pane gestures', () => {
    expect(usesPersistentSimSession(tap)).toBe(true)
  })

  it('lets agent tools demand a fresh input connection', () => {
    expect(usesPersistentSimSession(tap, { persistentSession: false })).toBe(false)
  })

  it('never creates a persistent session for text and hardware buttons', () => {
    expect(usesPersistentSimSession({ type: 'text' })).toBe(false)
    expect(usesPersistentSimSession({ type: 'press' })).toBe(false)
  })
})

describe('a device with more than one screen (iPhone Duo)', () => {
  it("lists its screens from simctl's enumerate: the ports that carry a framebuffer", () => {
    const out = readFileSync(join(__dirname, '__fixtures__', 'simctl-enumerate-duo.txt'), 'utf8')
    expect(parseScreens(out)).toEqual([
      { uuid: '5B875575-6FBE-4AF9-896C-AC322256B864', width: 1398, height: 2034 },
      { uuid: '3A9A8F16-6A4C-4F5A-B366-E4D68CA83175', width: 2007, height: 2853 }
    ])
  })

  it('works out which way a turned frame faces', () => {
    // A 24 × 34 portrait frame with a bright top row: turned clockwise, that
    // row becomes the right-hand column of the 34 × 24 upright picture.
    const w = 24
    const h = 34
    const raw = Array.from({ length: w * h }, (_, i) => (Math.floor(i / w) === 0 ? 255 : 0))
    const turnedCw = Array.from({ length: h * w }, (_, i) => (i % h === h - 1 ? 255 : 0))
    const turnedCcw = Array.from({ length: h * w }, (_, i) => (i % h === 0 ? 255 : 0))
    expect(orientationFrom(raw, turnedCw)).toBe('left')
    expect(orientationFrom(raw, turnedCcw)).toBe('right')
  })
})

describe('folding a foldable', () => {
  it('reads a posture as a hinge angle', () => {
    expect(postureAngle('open')).toBe(180)
    expect(postureAngle('Unfolded')).toBe(180)
    expect(postureAngle('folded')).toBe(0)
    expect(postureAngle('half')).toBe(90)
    expect(postureAngle(135)).toBe(135)
    expect(postureAngle('45')).toBe(45)
    // Out of range, or not a posture at all.
    expect(postureAngle(181)).toBeNull()
    expect(postureAngle(-1)).toBeNull()
    expect(postureAngle('sideways')).toBeNull()
    expect(postureAngle('')).toBeNull()
  })
})
