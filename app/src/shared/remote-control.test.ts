import { describe, expect, it } from 'vitest'
import {
  REMOTE_KEYS,
  REMOTE_LOCKOUT_MS,
  REMOTE_STRIKES,
  TokenBucket,
  cursorOnPicture,
  lockedUntil,
  newCode,
  remoteKey,
  remotePoint,
  remoteTextOk,
  sameCode,
  scrollPixels,
  spacedCode
} from './remote-control'

describe('which keys the phone may press', () => {
  it('takes letters, digits, arrows, function keys and modifiers from the allowed set', () => {
    expect(remoteKey('a')).toEqual({ ok: true, combo: 'a' })
    expect(remoteKey('space', ['cmd'])).toEqual({ ok: true, combo: 'cmd+space' })
    expect(remoteKey('up', ['ctrl'])).toEqual({ ok: true, combo: 'ctrl+up' })
    expect(remoteKey('f3')).toEqual({ ok: true, combo: 'f3' })
    expect(remoteKey('4', ['shift', 'cmd'])).toEqual({ ok: true, combo: 'cmd+shift+4' })
  })

  it('refuses a key or modifier that is not in the list', () => {
    expect(remoteKey('power').ok).toBe(false)
    expect(remoteKey('eject').ok).toBe(false)
    expect(remoteKey('a', ['super']).ok).toBe(false)
    expect(remoteKey('a+b').ok).toBe(false)
    expect(remoteKey('').ok).toBe(false)
    expect(REMOTE_KEYS).not.toContain('power')
  })

  it('refuses the stop shortcut, in every spelling the helper takes', () => {
    expect(remoteKey('escape', ['opt']).ok).toBe(false)
    expect(remoteKey('escape', ['opt', 'shift']).ok).toBe(false)
  })

  it('refuses Force Quit (command, option, escape) and anything with escape and option or command', () => {
    expect(remoteKey('escape', ['cmd', 'opt']).ok).toBe(false)
    expect(remoteKey('escape', ['cmd', 'opt', 'shift']).ok).toBe(false)
    expect(remoteKey('escape', ['cmd']).ok).toBe(false)
    // Escape on its own, and with control, is only escape.
    expect(remoteKey('escape').ok).toBe(true)
    expect(remoteKey('escape', ['ctrl']).ok).toBe(true)
  })

  it('refuses logging out, which would close Superagent and end the session', () => {
    expect(remoteKey('q', ['cmd', 'shift']).ok).toBe(false)
    expect(remoteKey('q', ['cmd', 'opt', 'shift']).ok).toBe(false)
    expect(remoteKey('q', ['cmd', 'opt']).ok).toBe(false)
    // Quitting the app in front is ordinary use; the guard checks it is not Superagent.
    expect(remoteKey('q', ['cmd']).ok).toBe(true)
  })

  it("refuses each of Superagent's own shortcuts, whatever spelling Electron's accelerator has", () => {
    const own = ['CommandOrControl+Shift+Space', 'Alt+Space', 'none', '']
    expect(remoteKey('space', ['cmd', 'shift'], own).ok).toBe(false)
    expect(remoteKey('space', ['opt'], own).ok).toBe(false)
    expect(remoteKey('space', ['cmd'], own).ok).toBe(true)
  })
})

describe('text the phone types', () => {
  it('is printable, and not empty or very long', () => {
    expect(remoteTextOk('héllo 👋')).toBe(true)
    expect(remoteTextOk('')).toBe(false)
    expect(remoteTextOk('a'.repeat(501))).toBe(false)
    expect(remoteTextOk('a'.repeat(500))).toBe(true)
  })
  it('has no control characters: Return and Tab are keys, not text', () => {
    for (const bad of ['a\nb', 'a\rb', 'a\tb', 'a\u0000b', 'a\u001bb', 'a\u007fb', 'a b'])
      expect(remoteTextOk(bad)).toBe(false)
  })
})

describe('where a point on the phone is on the Mac', () => {
  it('is a straight scale onto the display, whatever its size', () => {
    const area = { x: 0, y: 0, width: 1512, height: 982 }
    expect(remotePoint(area, 0, 0)).toEqual({ x: 0, y: 0 })
    expect(remotePoint(area, 0.5, 0.5)).toEqual({ x: 756, y: 491 })
    expect(remotePoint(area, 1, 1)).toEqual({ x: 1511, y: 981 })
  })
  it('lands on a display placed beside or above the main one, in system coordinates', () => {
    const right = { x: 1512, y: -200, width: 2560, height: 1440 }
    expect(remotePoint(right, 0, 0)).toEqual({ x: 1512, y: -200 })
    expect(remotePoint(right, 1, 1)).toEqual({ x: 1512 + 2559, y: -200 + 1439 })
    const left = { x: -1920, y: 0, width: 1920, height: 1080 }
    expect(remotePoint(left, 0.25, 0.5)).toEqual({ x: -1920 + 480, y: 540 })
  })
  it('never leaves the shared display, whatever the phone sends', () => {
    const area = { x: 100, y: 50, width: 800, height: 600 }
    for (const [fx, fy] of [
      [-5, -5],
      [9, 9],
      [Infinity, NaN],
      [1.0000001, 1]
    ]) {
      const p = remotePoint(area, fx, fy)
      expect(p.x).toBeGreaterThanOrEqual(100)
      expect(p.x).toBeLessThan(900)
      expect(p.y).toBeGreaterThanOrEqual(50)
      expect(p.y).toBeLessThan(650)
    }
  })
  it('says where the Mac pointer is on the picture, and null when it is on another display', () => {
    const area = { x: 1440, y: 0, width: 1000, height: 500 }
    expect(cursorOnPicture(area, { x: 1940, y: 250 })).toEqual({ x: 0.5, y: 0.5 })
    expect(cursorOnPicture(area, { x: 10, y: 10 })).toBeNull()
    expect(cursorOnPicture(area, { x: 2440, y: 0 })).toBeNull()
    expect(cursorOnPicture(area, { x: 1440, y: 499 })).not.toBeNull()
  })
  it('scrolls by pixels, held to what a flick can be', () => {
    const area = { x: 0, y: 0, width: 1000, height: 500 }
    expect(scrollPixels(area, 0.1, -0.2)).toEqual({ dx: 100, dy: -100 })
    expect(scrollPixels({ ...area, height: 100000 }, 0, 1)).toEqual({ dx: 0, dy: 3000 })
  })
})

describe('the small counters', () => {
  it('a token bucket allows a burst, then the rate', () => {
    const b = new TokenBucket(10, 5, 0)
    for (let i = 0; i < 5; i++) expect(b.take(1, 0)).toBe(true)
    expect(b.take(1, 0)).toBe(false)
    expect(b.take(1, 100)).toBe(true)
    expect(b.take(1, 100)).toBe(false)
    expect(b.take(5, 10_000)).toBe(true)
    expect(b.take(6, 20_000)).toBe(false)
  })
  it('codes are six digits, kept their leading zeros, and compared whole', () => {
    expect(newCode(() => 42)).toBe('000042')
    expect(newCode(() => 999_999)).toBe('999999')
    expect(spacedCode('482913')).toBe('482 913')
    expect(sameCode('482913', '482913')).toBe(true)
    expect(sameCode('482913', '482914')).toBe(false)
    expect(sameCode('482913', '48291')).toBe(false)
    expect(sameCode('', '')).toBe(true)
  })
  it('locks requests out after enough strikes in a short while, then lets go', () => {
    const t0 = 1_000_000
    expect(lockedUntil([], t0)).toBeNull()
    expect(lockedUntil(Array(REMOTE_STRIKES - 1).fill(t0), t0)).toBeNull()
    const strikes = Array(REMOTE_STRIKES).fill(t0)
    expect(lockedUntil(strikes, t0 + 1000)).toBe(t0 + REMOTE_LOCKOUT_MS)
    expect(lockedUntil(strikes, t0 + REMOTE_LOCKOUT_MS + 1)).toBeNull()
    // Old strikes do not count.
    expect(lockedUntil([t0 - 3_600_000, t0 - 3_600_000, t0], t0)).toBeNull()
  })
})
