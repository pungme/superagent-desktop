import { describe, expect, it } from 'vitest'
import {
  coverOthers,
  menuLevels,
  shellGapReason,
  shownText,
  stepText,
  windowPart,
  type LaidWindow,
  type Shot
} from './computer-use'

const display = { x: 0, y: 0, width: 100, height: 50 }
const shot: Shot = { width: 200, height: 100, area: display }
const win = (
  id: string | null,
  x: number,
  y: number,
  width: number,
  height: number,
  layer = 0,
  owner = id ?? 'Window Server'
): LaidWindow => ({
  app: id ? { id, name: id.split('.').pop()! } : null,
  owner,
  layer,
  frame: { x, y, width, height }
})
const white = (): Uint8Array => new Uint8Array(200 * 100 * 4).fill(255)
const at = (px: Uint8Array, x: number, y: number): number => px[(y * 200 + x) * 4]
const only = (id: string) => (x: string) => x === id

describe('a picture of only the allowed apps', () => {
  it('covers another app, the desktop, and keeps the allowed one', () => {
    const px = white()
    const hidden = coverOthers(
      px,
      shot,
      [win('com.apple.mail', 0, 10, 50, 40), win('com.apple.MobileSMS', 50, 10, 50, 40)],
      only('com.apple.mail')
    )
    expect(at(px, 20, 60)).toBe(255) // Mail
    expect(at(px, 150, 60)).toBe(0x2b) // Messages
    expect(at(px, 150, 5)).toBe(0x2b) // desktop
    expect(hidden).toEqual(['MobileSMS'])
  })

  it('goes by what is on top: an allowed window under another app is covered there', () => {
    const px = white()
    coverOthers(
      px,
      shot,
      [win('com.other.app', 20, 20, 20, 20), win('com.apple.mail', 0, 0, 100, 50)],
      only('com.apple.mail')
    )
    expect(at(px, 60, 60)).toBe(0x2b)
    expect(at(px, 10, 10)).toBe(255)
    // And the other way up, the allowed window shows over the other app.
    const px2 = white()
    coverOthers(
      px2,
      shot,
      [win('com.apple.mail', 20, 20, 20, 20), win('com.other.app', 0, 0, 100, 50)],
      only('com.apple.mail')
    )
    expect(at(px2, 60, 60)).toBe(255)
    expect(at(px2, 10, 10)).toBe(0x2b)
  })

  it('covered twice, with the windows before and after, shows only what both allow', () => {
    // Mail was in front when the windows were first listed; Messages had come
    // over half of it by the time they were listed again.
    const px = white()
    const mail = win('com.apple.mail', 0, 0, 100, 50)
    coverOthers(px, shot, [mail], only('com.apple.mail'))
    const hidden = coverOthers(
      px,
      shot,
      [win('com.apple.MobileSMS', 50, 0, 50, 50), mail],
      only('com.apple.mail')
    )
    expect(at(px, 20, 50)).toBe(255)
    expect(at(px, 150, 50)).toBe(0x2b)
    expect(hidden).toEqual(['MobileSMS'])
  })

  it('covers a notification, keeps the menu bar, and sees through the Dock', () => {
    const px = white()
    coverOthers(
      px,
      shot,
      [
        win(null, 0, 0, 100, 5, 24),
        win('com.apple.notificationcenterui', 70, 6, 28, 10, 23),
        win('com.apple.dock', 0, 0, 100, 50, 20),
        win('com.apple.mail', 0, 5, 100, 45)
      ],
      only('com.apple.mail')
    )
    expect(at(px, 100, 4)).toBe(255) // menu bar
    expect(at(px, 170, 20)).toBe(0x2b) // the notification
    expect(at(px, 40, 80)).toBe(255) // Mail, through the Dock's window
  })

  it('is not blanked by a utility overlay the size of the screen', () => {
    expect(windowPart(win('com.some.overlay', 0, 0, 100, 50, 25), display, () => false)).toBe('skip')
    expect(windowPart(win('com.some.app', 0, 0, 100, 50, 0), display, () => false)).toBe('hide')
    expect(windowPart(win(null, 0, 0, 10, 10, 0, 'loginwindow'), display, () => true)).toBe('hide')
  })

  it('measures windows from the display, wherever it sits on the desktop', () => {
    const second: Shot = { width: 200, height: 100, area: { x: 100, y: 0, width: 100, height: 50 } }
    const px = white()
    const hidden = coverOthers(
      px,
      second,
      [win('com.apple.mail', 150, 0, 50, 50), win('com.far.away', 0, 0, 50, 50)],
      only('com.apple.mail')
    )
    expect(at(px, 150, 50)).toBe(255)
    expect(at(px, 50, 50)).toBe(0x2b)
    expect(hidden).toEqual([])
  })
})

describe('a step, said before it is taken', () => {
  it('names the control when there is a name, the place when there is not', () => {
    expect(stepText({ type: 'click', x: 10.4, y: 20 }, 'Save')).toBe('Click "Save"')
    expect(stepText({ type: 'click', x: 10.4, y: 20 })).toBe('Click at 10, 20')
    expect(stepText({ type: 'click', x: 1, y: 2, count: 2 }, 'report.pdf')).toBe(
      'Double-click "report.pdf"'
    )
    expect(stepText({ type: 'click', x: 1, y: 2, button: 'right' })).toBe('Right-click at 1, 2')
  })
  it('shows all of what would be typed, line breaks and all', () => {
    expect(stepText({ type: 'type', text: 'hello' })).toBe('Type "hello"')
    // The second line is the one that matters.
    expect(stepText({ type: 'type', text: 'echo hi\nrm -rf ~\n' })).toBe(
      'Type "echo hi ⏎ rm -rf ~ ⏎ " (3 lines)'
    )
    expect(shownText('a'.repeat(700))).toBe(`"${'a'.repeat(600)}"… and 100 more characters`)
    expect(stepText({ type: 'key', keys: 'cmd+s' })).toBe('Press cmd+s')
    expect(stepText({ type: 'drag', x: 1, y: 2, toX: 30, toY: 40 })).toBe(
      'Drag from 1, 2 to 30, 40'
    )
  })
  it('reads a menu path the way the helper will, whatever is put on the end', () => {
    expect(menuLevels('File > Export > PDF…')).toEqual(['File', 'Export', 'PDF…'])
    expect(menuLevels('Safari > Quit Safari >')).toEqual(['Safari', 'Quit Safari'])
    expect(menuLevels(' > Finder >> Empty Trash… > > ')).toEqual(['Finder', 'Empty Trash…'])
  })
  it('has nothing to ask about a move or a scroll', () => {
    expect(stepText({ type: 'move' })).toBeNull()
    expect(stepText({ type: 'scroll' })).toBeNull()
  })
})

describe('an agent whose shell runs unseen', () => {
  it('is Codex in Full mode, and only that', () => {
    expect(shellGapReason('codex', 'bypassPermissions')).toContain('Ask mode')
    expect(shellGapReason('codex', undefined)).toContain('Ask mode')
    expect(shellGapReason('codex', 'ask')).toBeNull()
    expect(shellGapReason('codex', 'acceptEdits')).toBeNull()
    expect(shellGapReason('claude', 'bypassPermissions')).toBeNull()
    expect(shellGapReason('antigravity', 'bypassPermissions')).toBeNull()
  })
})
