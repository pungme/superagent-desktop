import { describe, expect, it } from 'vitest'
import {
  CONSENT_IDLE_MS,
  consentStands,
  appCaution,
  describeControls,
  riskyControl,
  toShotPoint,
  zoomRect,
  appFrom,
  bundleIdFrom,
  heldByAnother,
  isSelfApp,
  LOCK_MS,
  focusMoved,
  normalKeyCombo,
  offLimitsApp,
  overlaps,
  ownerApp,
  typedLines,
  riskyShortcut,
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

describe("the user's own list, and Superagent itself", () => {
  it('keeps out of an app the user added, by its exact id', () => {
    const denied = [{ id: 'com.tinyspeck.slackmacgap', name: 'Slack' }]
    expect(offLimitsApp('com.tinyspeck.slackmacgap', denied)).toBe('Slack')
    expect(offLimitsApp('com.tinyspeck.slackmacgap.helper', denied)).toBeNull()
    // The built-in list still comes first.
    expect(offLimitsApp('com.1password.1password', denied)).toBe('1Password')
  })
  it("knows Superagent's own app, packaged or run from source", () => {
    expect(isSelfApp('dev.superagent.app')).toBe(true)
    expect(isSelfApp('com.github.Electron')).toBe(true)
    expect(isSelfApp('com.apple.finder')).toBe(false)
    expect(isSelfApp(null)).toBe(false)
  })
  it('reads an app, with its name, out of what macOS prints', () => {
    expect(
      appFrom('"SuperAgent" ASN:0x0-0x5a049ff: (in front) \n    bundleID="dev.superagent.app"\n')
    ).toEqual({ id: 'dev.superagent.app', name: 'SuperAgent' })
    // No name given: the id stands in. An invisible mark in front of one is dropped.
    expect(appFrom('[ NULL ] ASN:0x0-0x1: \n bundleID="com.x.y"')).toEqual({
      id: 'com.x.y',
      name: 'com.x.y'
    })
    expect(appFrom('"\u200eWhatsApp" ASN:0x0: \n bundleID="net.whatsapp.WhatsApp"')?.name).toBe(
      'WhatsApp'
    )
    expect(appFrom('nothing')).toBeNull()
  })
})

describe('what is at stake in an app', () => {
  it('warns for the ones that can do real damage, and is quiet for the rest', () => {
    expect(appCaution('com.apple.Terminal')).toContain('command')
    expect(appCaution('com.googlecode.iterm2')).toContain('command')
    expect(appCaution('com.microsoft.VSCode')).toContain('code')
    expect(appCaution('com.apple.finder')).toContain('files')
    expect(appCaution('com.apple.Safari')).toContain('signed in')
    expect(appCaution('com.apple.mail')).toContain('send')
    expect(appCaution('com.apple.TextEdit')).toBe('')
  })
})

describe('one conversation on the Mac at a time', () => {
  it('holds it for a minute after the last thing done, against others only', () => {
    const holder = { owner: 'a', at: 1_000 }
    expect(heldByAnother(holder, 'b', 1_000 + LOCK_MS - 1)).toBe(true)
    expect(heldByAnother(holder, 'b', 1_000 + LOCK_MS)).toBe(false)
    expect(heldByAnother(holder, 'a', 1_001)).toBe(false)
    expect(heldByAnother(null, 'b', 1_001)).toBe(false)
  })
})

describe('shortcuts that end or destroy something', () => {
  it('are known however they are spelled', () => {
    expect(normalKeyCombo('Shift+Command+Q')).toBe('cmd+shift+q')
    expect(normalKeyCombo('alt+cmd+escape')).toBe('cmd+opt+esc')
    expect(riskyShortcut('cmd+q')).toContain('quits')
    expect(riskyShortcut('Command+Shift+Q')).toContain('logs you out')
    expect(riskyShortcut('ctrl+cmd+q')).toContain('locks')
    expect(riskyShortcut('cmd+option+escape')).toContain('Force Quit')
    expect(riskyShortcut('cmd+backspace')).toContain('Trash')
    expect(riskyShortcut('shift+cmd+delete')).toContain('empties the Trash')
    expect(riskyShortcut('cmd+alt+delete')).toContain('skipping the Trash')
  })
  it('leave ordinary ones alone', () => {
    for (const ok of [
      'cmd+c',
      'cmd+v',
      'return',
      'cmd+w',
      'cmd+space',
      'delete',
      'cmd+shift+4',
      'q'
    ])
      expect(riskyShortcut(ok), ok).toBeNull()
  })
})

describe("windows that are not an app's", () => {
  it("are known by their owner's name, and the system's prompts are out of bounds", () => {
    expect(ownerApp('SecurityAgent', '')).toEqual({
      id: 'name:SecurityAgent',
      name: 'SecurityAgent'
    })
    for (const prompt of [
      'SecurityAgent',
      'coreautha',
      'universalAccessAuthWarn',
      'CoreServicesUIAgent'
    ])
      expect(offLimitsApp(ownerApp(prompt, '')!.id), prompt).toBe(
        'a macOS password or permission prompt'
      )
    // Some other tool with a window of its own is just a thing to ask about.
    expect(offLimitsApp(ownerApp('ffplay', '')!.id)).toBeNull()
  })
  it('leave the menu bar and desktop to the app in front, and prefer a bundle id when there is one', () => {
    expect(ownerApp('Window Server', '')).toBeNull()
    expect(ownerApp('', '')).toBeNull()
    expect(ownerApp('\u200eWhatsApp', 'net.whatsapp.WhatsApp')).toEqual({
      id: 'net.whatsapp.WhatsApp',
      name: 'WhatsApp'
    })
  })
})

describe('text as the pieces it is typed in', () => {
  it('is one piece without a Return, else a line at a time with its Return', () => {
    expect(typedLines('hello world')).toEqual(['hello world'])
    expect(typedLines('a\nb\n')).toEqual(['a\n', 'b\n'])
    expect(typedLines('Terminal\nls')).toEqual(['Terminal\n', 'ls'])
    expect(typedLines('\n')).toEqual(['\n'])
    expect(typedLines('')).toEqual([])
  })
})

describe('the controls on screen, for an agent to act on', () => {
  const shot = { width: 1440, height: 900, area: { x: 0, y: 0, width: 2880, height: 1800 } }
  const control = (over: Record<string, unknown>): never =>
    ({
      role: 'Button',
      label: 'Save',
      value: '',
      x: 200,
      y: 100,
      w: 80,
      h: 40,
      enabled: true,
      ...over
    }) as never
  it('says what each is called and where to click for it, on the screenshot', () => {
    expect(toShotPoint(shot, 240, 120)).toEqual({ x: 120, y: 60 })
    expect(describeControls(shot, [control({})])).toEqual(['button "Save" at 120,60'])
    // Numbered, so it can be pressed by name rather than by where it is.
    expect(describeControls(shot, [control({ i: 7 })])).toEqual(['[7] button "Save" at 120,60'])
    expect(
      describeControls(shot, [control({ role: 'TextField', label: 'Email', value: 'a@b.c' })])
    ).toEqual(['text field "Email" = "a@b.c" at 120,60'])
    expect(
      describeControls(shot, [control({ role: 'CheckBox', label: 'Remember', enabled: false })])
    ).toEqual(['check box "Remember" (disabled) at 120,60'])
  })
  it('never shows what a password field holds', () => {
    expect(
      describeControls(shot, [
        control({ role: 'SecureTextField', label: 'Password', value: '(hidden)' })
      ])
    ).toEqual(['secure text field "Password" = (hidden) at 120,60'])
  })
  it('leaves out what has no name; what is on another display has a number but no point', () => {
    expect(describeControls(shot, [control({ label: '', value: '' })])).toEqual([])
    expect(describeControls(shot, [control({ i: 2, x: 5000 })])).toEqual([
      '[2] button "Save" (not on this display: use its number)'
    ])
    expect(toShotPoint(shot, -10, 5)).toBeNull()
  })
})

describe('a click on something that ends or destroys', () => {
  it('is known by what the control is called', () => {
    expect(riskyControl('AXMenuItem', 'Log Out Worathiti…')).toContain('logs you out')
    expect(riskyControl('AXMenuItem', 'Shut Down…')).toContain('shuts down')
    expect(riskyControl('AXMenuItem', 'Empty Trash…')).toContain('deletes for good')
    expect(riskyControl('AXMenuItem', 'Move to Trash')).toContain('deletes')
    expect(riskyControl('AXMenuItem', 'Quit Safari')).toContain('quits')
    expect(riskyControl('AXButton', 'Erase All Content and Settings…')).toContain(
      'deletes for good'
    )
    expect(riskyControl('AXButton', 'Send')).toContain('sends')
    expect(riskyControl('AXButton', 'Buy Now')).toContain('spends money')
  })
  it('leaves ordinary controls alone, and text that only mentions the words', () => {
    for (const [role, label] of [
      ['AXButton', 'Save'],
      ['AXMenuItem', 'New Window'],
      ['AXMenuItem', 'Restart Recording'],
      ['AXButton', 'Sender details'],
      ['AXStaticText', 'Log Out'],
      ['AXButton', '']
    ])
      expect(riskyControl(role, label), `${role} ${label}`).toBeNull()
  })
})

describe('the part of the screen to enlarge', () => {
  const shot = { width: 1440, height: 900, area: { x: 0, y: 0, width: 1440, height: 900 } }
  it('is kept inside the picture', () => {
    expect(zoomRect(shot, { x: 1400, y: 880, width: 300, height: 300 })).toEqual({
      x: 1400,
      y: 880,
      width: 40,
      height: 20
    })
    expect(zoomRect(shot, { x: 10, y: 10, width: 200, height: 100 })).toEqual({
      x: 10,
      y: 10,
      width: 200,
      height: 100
    })
  })
  it('is refused when nothing worth seeing is left', () => {
    expect(zoomRect(shot, { x: 1439, y: 10, width: 200, height: 100 })).toBeNull()
    expect(zoomRect(shot, { x: 10, y: 10, width: 5, height: 5 })).toBeNull()
  })
})

describe('whether a window is in the part of the desktop being pictured', () => {
  const laptop = { x: 0, y: 0, width: 1728, height: 1117 }
  it('is, when any of it is on that display', () => {
    expect(overlaps({ x: 100, y: 100, width: 900, height: 530 }, laptop)).toBe(true)
    expect(overlaps({ x: 1700, y: 400, width: 900, height: 530 }, laptop)).toBe(true)
  })
  it('is not, on the display beside it or wholly off it', () => {
    expect(overlaps({ x: 2220, y: 446, width: 900, height: 530 }, laptop)).toBe(false)
    expect(overlaps({ x: 1728, y: 0, width: 500, height: 500 }, laptop)).toBe(false)
    expect(overlaps({ x: -6000, y: -6000, width: 300, height: 160 }, laptop)).toBe(false)
  })
})
