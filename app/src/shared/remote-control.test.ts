import { describe, expect, it } from 'vitest'
import { settingsWords } from './remote-control-words'
import {
  REMOTE_ASKS_PER_HOUR,
  REMOTE_ASK_WINDOW_MS,
  REMOTE_KEYS,
  REMOTE_LOCKOUT_MS,
  REMOTE_STRIKES,
  TokenBucket,
  MENU_BAR_BAND,
  allowDialog,
  bannerHidden,
  clipboardConcealed,
  inAppleMenu,
  launcherOnScreen,
  onDock,
  ownModalUp,
  pastes,
  askBudgetLeftAt,
  cleanDeviceName,
  cursorOnPicture,
  lockedUntil,
  newCode,
  quietRun,
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

describe("a phone's name, and the words of the Allow dialog", () => {
  it('has control, format, separator and C1 characters taken out, spaces collapsed, and is cut at 60', () => {
    expect(cleanDeviceName("Pung's iPhone")).toBe("Pung's iPhone")
    // bidi overrides and isolates, zero width, BOM, soft hyphen
    expect(cleanDeviceName('a\u202eb\u202ac\u2066d\u2069e\u200bf\ufeffg\u00adh')).toBe(
      'a b c d e f g h'
    )
    // C0, DEL, C1 (NEL), line and paragraph separators, no-break space
    expect(cleanDeviceName('x\n\u0000y\u007fz\u0085w\u2028v\u2029u\u00a0t')).toBe('x y z w v u t')
    expect(cleanDeviceName('   a   b   ')).toBe('a b')
    expect(cleanDeviceName('\u202e\u200b ')).toBe('a phone')
    expect(Array.from(cleanDeviceName('é'.repeat(200)))).toHaveLength(60)
  })

  it('says what the phone can reach and promises no more than the guard delivers', () => {
    const off = allowDialog('Pung iPhone', false)
    expect(off.detail.startsWith('Paired phone: Pung iPhone')).toBe(true)
    expect(off.detail).toMatch(/sees this screen live/)
    expect(off.detail).toMatch(/mouse and keyboard as you, in nearly any app, for up to 2 hours/)
    expect(off.detail).toMatch(/10 minutes without input/)
    expect(off.detail).toMatch(/⌥Esc or Stop/)
    expect(off.detail).toMatch(/not a guarantee/)
    expect(off.detail).toMatch(/Mail and Messages \(including one-time codes/)
    expect(off.detail).toMatch(/saved logins/)
    expect(off.detail).toMatch(/restarting the Mac/)
    expect(off.detail).toMatch(/nothing it did is undone/)
    expect(off.detail).toMatch(/Touch ID or password prompt/)
    expect(off.detail).toMatch(/stay near the Mac/)
    // A list, never a wall.
    expect(off.detail).not.toMatch(/blocked|never|cannot use|can't use|cannot be/i)
    expect(off.detail).not.toMatch(/run commands as you/)
    const on = allowDialog('Pung iPhone', true)
    expect(on.detail).toMatch(/run commands as you/)
    // The name is never in the headline.
    expect(off.message).not.toMatch(/Pung/)
  })

  it('counts an hour of asks, cancelled or not', () => {
    const t = 10_000_000
    expect(askBudgetLeftAt([], t)).toBeNull()
    const some = Array.from({ length: REMOTE_ASKS_PER_HOUR - 1 }, (_, i) => t - i * 1000)
    expect(askBudgetLeftAt(some, t)).toBeNull()
    const full = [...some, t - 50_000]
    // Free again when the oldest of them is an hour old.
    expect(askBudgetLeftAt(full, t)).toBe(Math.min(...full) + REMOTE_ASK_WINDOW_MS)
    expect(askBudgetLeftAt(full, Math.min(...full) + REMOTE_ASK_WINDOW_MS)).toBeNull()
  })

  it('a quiet test run is never a packaged app', () => {
    expect(quietRun({ COVE_E2E_QUIET: '1' }, false)).toBe(true)
    expect(quietRun({ COVE_E2E_QUIET: '1' }, true)).toBe(false)
    expect(quietRun({}, false)).toBe(false)
    expect(quietRun({ COVE_E2E_QUIET: '0' }, false)).toBe(false)
  })
})

describe("the guard's pure rules", () => {
  const w = (id: string | null, layer: number, x = 0, y = 0, width = 100, height = 100): never =>
    ({
      app: id ? { id, name: id } : null,
      owner: id ?? 'Window Server',
      layer,
      frame: { x, y, width, height }
    }) as never
  it('knows a paste in all its spellings', () => {
    expect(pastes('v', ['cmd'])).toBe(true)
    expect(pastes('V', ['cmd', 'shift', 'opt'])).toBe(true)
    expect(pastes('v', ['cmd', 'ctrl'])).toBe(true)
    // Virtual machines, remote desktops, terminals and command palettes paste with Control.
    expect(pastes('v', ['ctrl'])).toBe(true)
    expect(pastes('v', ['ctrl', 'shift'])).toBe(true)
    expect(pastes('v', [])).toBe(false)
    expect(pastes('c', ['cmd'])).toBe(false)
  })
  it("reads a password manager's mark with has(), the way Electron 39 on macOS really answers", () => {
    // availableFormats() lists only MIME names there, so it is not what is asked.
    const real = (marked: string[]): { availableFormats(): string[]; has(f: string): boolean } => ({
      availableFormats: () => ['text/plain'],
      has: (f) => marked.includes(f)
    })
    expect(clipboardConcealed(real(['org.nspasteboard.ConcealedType']))).toBe(true)
    expect(clipboardConcealed(real(['org.nspasteboard.TransientType']))).toBe(true)
    expect(clipboardConcealed(real(['com.agilebits.onepassword']))).toBe(true)
    expect(clipboardConcealed(real(['de.petermaurer.TransientPasteboardType']))).toBe(true)
    expect(clipboardConcealed(real([]))).toBe(false)
    expect(clipboardConcealed(real(['org.nspasteboard.AutoGeneratedType']))).toBe(false)
    // Not being able to tell is a yes.
    expect(
      clipboardConcealed({
        has: () => {
          throw new Error('no pasteboard')
        }
      })
    ).toBe(true)
  })
  it("knows Superagent's own dialogs and menus from its dot, its ordinary windows and the banner", () => {
    expect(ownModalUp([w('dev.superagent.app', 8)])).toBe(true)
    expect(ownModalUp([w('com.github.electron', 101)])).toBe(true)
    expect(ownModalUp([w('dev.superagent.app', 3), w('dev.superagent.app', 0)])).toBe(false)
    expect(ownModalUp([w('dev.superagent.app', 1000)])).toBe(false)
    expect(ownModalUp([w('com.apple.Notes', 8)])).toBe(false)
  })
  it("knows the Apple menu and the Dock's windows", () => {
    const d = { x: 0, y: 0, width: 1000, height: 500 }
    expect(inAppleMenu(d, { x: 10, y: 5 })).toBe(true)
    expect(inAppleMenu(d, { x: 60, y: 5 })).toBe(false)
    expect(inAppleMenu(d, { x: 10, y: 60 })).toBe(false)
    expect(inAppleMenu({ ...d, x: 1000 }, { x: 1010, y: 5 })).toBe(true)
    expect(onDock([w('com.apple.dock', 20, 200, 450, 600, 50)], { x: 500, y: 470 })).toBe(true)
    expect(onDock([w('com.apple.dock', 20, 200, 450, 600, 50)], { x: 500, y: 100 })).toBe(false)
  })
  it('sees a launcher on screen, and does not take the Dock for one', () => {
    expect(launcherOnScreen([w('com.apple.Spotlight', 3)])).toBe(true)
    expect(launcherOnScreen([w('com.raycast.macos', 3)])).toBe(true)
    expect(launcherOnScreen([w('com.apple.dock', 20), w('com.apple.Notes', 0)])).toBe(false)
  })
})

describe('keys that reach the menu bar, the Dock, VoiceOver or a menu search', () => {
  it('refuses Control with F1 to F8, with or without fn, which focus the menu bar and the Dock', () => {
    for (let n = 1; n <= 8; n++) {
      expect(remoteKey(`f${n}`, ['ctrl']).ok, `ctrl+f${n}`).toBe(false)
      expect(remoteKey(`f${n}`, ['ctrl', 'fn']).ok, `fn+ctrl+f${n}`).toBe(false)
    }
    expect(remoteKey('f2', ['ctrl', 'shift', 'cmd']).ok).toBe(false)
  })
  it('refuses Control-Option, ⌘F5 and ⌥F5, and the Help menu search (⇧⌘/)', () => {
    expect(remoteKey('a', ['ctrl', 'opt']).ok).toBe(false)
    expect(remoteKey('a', ['ctrl', 'opt', 'cmd']).ok).toBe(false)
    expect(remoteKey('f5', ['cmd']).ok).toBe(false)
    expect(remoteKey('f5', ['opt']).ok).toBe(false)
    expect(remoteKey('/', ['cmd', 'shift']).ok).toBe(false)
  })
  it('still takes what people use: F keys on their own, ⌘, ⌃ arrows, ⌘/', () => {
    expect(remoteKey('f2').ok).toBe(true)
    expect(remoteKey('f9', ['ctrl']).ok).toBe(true)
    expect(remoteKey('f5', ['shift']).ok).toBe(true)
    expect(remoteKey('up', ['ctrl']).ok).toBe(true)
    expect(remoteKey('/', ['cmd']).ok).toBe(true)
    expect(remoteKey('space', ['ctrl', 'cmd']).ok).toBe(true)
  })
})

describe('what the Allow dialog and Settings say: the same words, no absolutes', () => {
  for (const shells of [false, true]) {
    for (const [name, text] of [
      ['the dialog', allowDialog('Pung iPhone', shells).detail],
      ['Settings', settingsWords(shells)]
    ] as const)
      it(`${name} (shells ${shells ? 'allowed' : 'not allowed'}) says what is reachable and how it ends`, () => {
        expect(text).toMatch(/sees this screen live/)
        expect(text).toMatch(/mouse and keyboard as you, in nearly any app, for up to 2 hours/)
        expect(text).toMatch(/10 minutes without input/)
        expect(text).toMatch(/⌥Esc or Stop/)
        expect(text).toMatch(/Mail and Messages \(including one-time codes/)
        expect(text).toMatch(/Finder and every file/)
        expect(text).toMatch(/sites you are signed in to/)
        expect(text).toMatch(/restarting the Mac/)
        expect(text).toMatch(/saved logins/)
        expect(text).toMatch(/not a guarantee/)
        expect(text).toMatch(/nothing it did is undone/)
        expect(text).toMatch(/Touch ID or password prompt/)
        expect(text).toMatch(/stay near the Mac/)
        expect(text).not.toMatch(/blocked|never|cannot use|can't use|cannot be/i)
        // Terminals are named as kept away from only while that is true.
        expect(/and terminals/.test(text)).toBe(!shells)
        expect(/run commands as you/.test(text)).toBe(shells)
      })
  }
  it('Settings adds that it asks each time and stays on after a restart', () => {
    expect(settingsWords(false)).toMatch(/shows a code/)
    expect(settingsWords(false)).toMatch(/stays on after a restart/)
  })
})

describe('the menu bar band and a banner behind a full-screen app', () => {
  const area = { x: 0, y: 0, width: 1000, height: 500 }
  const w = (id: string, layer: number, x = 0, y = 0, width = 1000, height = 500): never =>
    ({ app: { id, name: id }, owner: id, layer, frame: { x, y, width, height } }) as never
  it('is a fixed 40 points', () => {
    expect(MENU_BAR_BAND).toBe(40)
    expect(inAppleMenu(area, { x: 10, y: 39 })).toBe(true)
    expect(inAppleMenu(area, { x: 10, y: 40 })).toBe(false)
  })
  it('is hidden when a full-screen window is in front of it, or it is not on screen at all', () => {
    const banner = w('dev.superagent.app', 1000, 280, 6, 440, 40)
    expect(bannerHidden([w('com.apple.Safari', 0), banner], area)).toBe(true)
    expect(bannerHidden([w('com.apple.Safari', 0)], area)).toBe(true)
  })
  it('is fine when it is in front of the full-screen window, or nothing is full-screen', () => {
    const banner = w('dev.superagent.app', 1000, 280, 6, 440, 40)
    expect(bannerHidden([banner, w('com.apple.Safari', 0)], area)).toBe(false)
    // A maximised window starts below the menu bar: not full-screen.
    expect(bannerHidden([w('com.apple.Safari', 0, 0, 25, 1000, 475)], area)).toBe(false)
    expect(bannerHidden([w('com.apple.Safari', 0, 0, 0, 500, 400)], area)).toBe(false)
  })
})
