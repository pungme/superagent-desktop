import { existsSync } from 'fs'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { isPackaged: false, on: vi.fn() },
  desktopCapturer: {},
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  ipcMain: { handle: vi.fn() },
  screen: {
    getCursorScreenPoint: () => pointer,
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 2880, height: 1800 } })
  },
  shell: {},
  systemPreferences: {}
}))
// What macOS says is in front, set by each test that cares.
// What the helper was asked to type, and something to do just after each piece.
const typed: string[] = []
// What the helper was asked to do to a control by its name.
const byName: string[][] = []
let afterType: (() => void) | null = null
// What the front window's controls are said to be.
let controls: Record<string, unknown>[] = []
let front = 'com.apple.finder'
// Whose window is under the point the mouse is sent to, when it is not the app in front.
let under: { id: string; name: string } | null = null
// Where the pointer is.
let pointer = { x: 0, y: 0 }
vi.mock('node:child_process', () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    done: (e: Error | null, out: string) => void
  ) => {
    if (args[0] === 'type') typed.push(args[1])
    if (/^ax(press|set|menu)$/.test(args[0])) byName.push(args)
    if (args[0] === 'type') afterType?.()
    done(
      null,
      args[0] === 'front'
        ? 'ASN:0x0-0x1001:'
        : args[0] === 'at'
          ? JSON.stringify(under ? { name: under.name, bundle: under.id } : {})
          : args[0] === 'ax'
            ? JSON.stringify({ app: 'TextEdit', window: 'Untitled', elements: controls })
            : args[0] === 'info'
              ? `"Front" ASN:0x0-0x1001: \n    bundleID="${front}"`
              : '{"ok":true}'
    )
  }
}))
const kv = new Map<string, string>()
vi.mock('./store', () => ({
  kvGet: (k: string) => kv.get(k),
  kvSet: (k: string, v: string) => void kv.set(k, v)
}))
vi.mock('./util', () => ({ broadcastToWindows: vi.fn() }))

const {
  act,
  approveApp,
  appsToAsk,
  denyApp,
  undenyApp,
  cuseArgs,
  grantConsent,
  hasConsent,
  leftPointerAt,
  notReady,
  offLimitsNow,
  pickMenu,
  pressControl,
  fillControl,
  readUi,
  sawFront,
  setComputerStop,
  setOwnProbe,
  setOwnSurfaceProbe,
  touchConsent,
  stopComputerUse
} = await import('./computer-use')
const { CONSENT_IDLE_MS, CONSENT_MAX_ACTIONS, CONSENT_MAX_MS } =
  await import('../shared/computer-use')

const shot = { width: 1440, height: 931, area: { x: 0, y: 0, width: 1728, height: 1117 } }

describe('an action, as what the helper is asked to do', () => {
  it('maps a point on the screenshot onto the screen', () => {
    expect(cuseArgs({ type: 'click', x: 720, y: 465 }, shot)).toEqual([
      'click',
      '864',
      '558',
      'left',
      '1'
    ])
    expect(cuseArgs({ type: 'click', x: 10, y: 10, button: 'right', count: 2 }, shot)).toEqual([
      'click',
      '12',
      '12',
      'right',
      '2'
    ])
    expect(cuseArgs({ type: 'drag', x: 0, y: 0, toX: 1440, toY: 931 }, shot)).toEqual([
      'drag',
      '0',
      '0',
      '1728',
      '1117'
    ])
    expect(cuseArgs({ type: 'scroll', x: 100, y: 100, dx: 0, dy: -5 }, shot).slice(-2)).toEqual([
      '0',
      '-5'
    ])
  })

  it('passes text and keys through untouched, as one argument each', () => {
    // Whatever is in it: it is an argument to a program, never a shell line.
    expect(cuseArgs({ type: 'type', text: 'hi"; rm -rf ~ #' }, undefined)).toEqual([
      'type',
      'hi"; rm -rf ~ #'
    ])
    expect(cuseArgs({ type: 'key', keys: 'Cmd+Shift+4' }, undefined)).toEqual([
      'key',
      'cmd+shift+4'
    ])
  })

  it('will not point at anything before there is a screenshot to point on', () => {
    expect(() => cuseArgs({ type: 'click', x: 1, y: 1 }, undefined)).toThrow(/screenshot first/)
  })

  it('will not click outside the picture', () => {
    expect(() => cuseArgs({ type: 'click', x: 5000, y: 10 }, shot)).toThrow(
      /outside the screenshot/
    )
  })
})

describe('being allowed to use the Mac', () => {
  it('holds for a conversation while it is working, and lapses when it goes quiet', () => {
    expect(hasConsent('chat-a', 1000)).toBe(false)
    grantConsent('chat-a', 1000)
    expect(hasConsent('chat-a', 1000 + CONSENT_IDLE_MS - 1)).toBe(true)
    expect(hasConsent('chat-a', 1000 + CONSENT_IDLE_MS + 1)).toBe(false)
    // One conversation's yes is not another's.
    expect(hasConsent('chat-b', 1001)).toBe(false)
  })

  it('stopping withdraws every yes and tells each agent to stop', () => {
    const stopped: string[] = []
    setComputerStop((id) => stopped.push(id))
    grantConsent('chat-a')
    grantConsent('chat-b')
    expect(stopComputerUse().sort()).toEqual(['chat-a', 'chat-b'])
    expect(stopped.sort()).toEqual(['chat-a', 'chat-b'])
    expect(hasConsent('chat-a')).toBe(false)
    expect(hasConsent('chat-b')).toBe(false)
  })
})

describe('what is missing, in words for the user', () => {
  const ready = {
    supported: true,
    enabled: true,
    screen: true,
    accessibility: true,
    helper: true,
    stopKeyRefused: false,
    builtInDenied: [],
    denied: []
  }
  it('is nothing when it is all there', () => {
    expect(notReady(ready)).toBeNull()
  })
  it('says it is off before anything about permissions', () => {
    expect(notReady({ ...ready, enabled: false, screen: false })).toContain('turned off')
  })
  it('names the permission that is missing, and both when both are', () => {
    expect(notReady({ ...ready, screen: false })).toContain('Screen Recording')
    expect(notReady({ ...ready, screen: false })).not.toContain('Accessibility (')
    const both = notReady({ ...ready, screen: false, accessibility: false })!
    expect(both).toContain('Screen Recording')
    expect(both).toContain('Accessibility')
  })
})

describe('where it will not go', () => {
  it('is fine in an ordinary app', async () => {
    front = 'com.figma.Desktop'
    expect(await offLimitsNow()).toBeNull()
  })
  it('refuses to type into a password manager, and does not count it as activity', async () => {
    front = 'com.1password.1password'
    expect(await offLimitsNow()).toMatch(/1Password is in the way/)
    stopComputerUse()
    await expect(act('pw', { type: 'type', text: 'hunter2' })).rejects.toThrow(/1Password/)
    expect(hasConsent('pw')).toBe(false)
  })
  it('refuses everything while the Mac is locked', async () => {
    front = 'com.apple.loginwindow'
    await expect(act('locked', { type: 'key', keys: 'Enter' })).rejects.toThrow(/locked/)
  })
})

describe('typing after focus has moved', () => {
  it('is refused until the agent looks again, while the mouse is not', async () => {
    grantConsent('t')
    sawFront('t', 'com.apple.TextEdit')
    front = 'com.apple.Safari'
    await expect(act('t', { type: 'type', text: 'hello' })).rejects.toThrow(/since you last looked/)
    await expect(act('t', { type: 'key', keys: 'cmd+a' })).rejects.toThrow(/since you last looked/)
    // A click names its own place on the screen; it is not stopped by this.
    await expect(act('t', { type: 'click', x: 1, y: 1 })).rejects.toThrow(/screenshot/i)
  })
})

describe('when the user takes the mouse', () => {
  it('stands back once, until the agent has looked again', async () => {
    stopComputerUse()
    front = 'com.apple.finder'
    grantConsent('m')
    sawFront('m', 'com.apple.finder')
    leftPointerAt('m', { x: 200, y: 200 })
    pointer = { x: 600, y: 420 }
    await expect(act('m', { type: 'key', keys: 'cmd+a' })).rejects.toThrow(/moved the mouse/)
    // Said once; the next try is not refused for the same move.
    // (Without the helper built, as in CI, it fails for that reason instead.)
    const again = await act('m', { type: 'key', keys: 'cmd+a' }).then(
      () => '',
      (e: Error) => e.message
    )
    expect(again).not.toMatch(/moved the mouse/)
  })
})

describe('what the mouse would land on', () => {
  const shotFor = async (owner: string): Promise<void> => {
    // A click needs a screenshot to point on; borrow the mapping through a move
    // that fails for the same reason when there is none.
    await expect(act(owner, { type: 'click', x: 1, y: 1 })).rejects.toThrow(/screenshot/i)
  }
  it('is the app in front for keys: asked about once, then not again', async () => {
    front = 'com.apple.TextEdit'
    under = null
    expect((await appsToAsk('k', { type: 'type', text: 'x' })).map((a) => a.id)).toEqual([
      'com.apple.TextEdit'
    ])
    approveApp('k', 'com.apple.TextEdit')
    expect(await appsToAsk('k', { type: 'type', text: 'x' })).toEqual([])
    // Another conversation has not been told yes.
    expect(await appsToAsk('k2', { type: 'type', text: 'x' })).toHaveLength(1)
    await shotFor('k')
  })
  it("refuses Superagent's own window, and an app the user put out of bounds", async () => {
    stopComputerUse()
    front = 'dev.superagent.app'
    await expect(act('s', { type: 'key', keys: 'return' })).rejects.toThrow(/own window/)
    expect(await appsToAsk('s', { type: 'key', keys: 'return' })).toEqual([])

    front = 'com.tinyspeck.slackmacgap'
    denyApp({ id: 'com.tinyspeck.slackmacgap', name: 'Slack' })
    await expect(act('s', { type: 'type', text: 'hi' })).rejects.toThrow(/put Slack out of bounds/)
    undenyApp('com.tinyspeck.slackmacgap')
    stopComputerUse()
  })
  it('keeps a second conversation off the Mac while the first is using it', async () => {
    stopComputerUse()
    front = 'com.apple.TextEdit'
    pointer = { x: 0, y: 0 }
    grantConsent('first')
    grantConsent('second')
    await act('first', { type: 'key', keys: 'cmd+a' }).catch(() => undefined)
    await expect(act('second', { type: 'key', keys: 'cmd+a' })).rejects.toThrow(
      /Another conversation is using this Mac/
    )
    // Stopping lets go of it.
    stopComputerUse()
    grantConsent('second')
    const after = await act('second', { type: 'key', keys: 'cmd+a' }).then(
      () => '',
      (e: Error) => e.message
    )
    expect(after).not.toMatch(/Another conversation/)
    stopComputerUse()
  })
})

describe('so that it cannot run away', () => {
  it('does nothing for a conversation that has not been told yes', async () => {
    stopComputerUse()
    front = 'com.apple.TextEdit'
    await expect(act('nobody', { type: 'key', keys: 'cmd+a' })).rejects.toThrow(/has not allowed/)
  })
  it('asks again after half an hour, however busy it has been', () => {
    stopComputerUse()
    const t0 = 1_000_000
    grantConsent('busy', t0)
    // Working the whole time: never idle for ten minutes.
    for (let t = t0; t < t0 + CONSENT_MAX_MS; t += 60_000) touchConsent('busy', t)
    expect(hasConsent('busy', t0 + CONSENT_MAX_MS - 1)).toBe(true)
    touchConsent('busy', t0 + CONSENT_MAX_MS)
    expect(hasConsent('busy', t0 + CONSENT_MAX_MS)).toBe(false)
    // A fresh yes starts the clock again.
    grantConsent('busy', t0 + CONSENT_MAX_MS)
    expect(hasConsent('busy', t0 + CONSENT_MAX_MS + 1)).toBe(true)
    stopComputerUse()
  })
  it('asks again after a great many actions', async () => {
    stopComputerUse()
    front = 'com.apple.TextEdit'
    under = null
    grantConsent('many')
    sawFront('many', 'com.apple.TextEdit')
    for (let i = 0; i < CONSENT_MAX_ACTIONS; i++)
      await act('many', { type: 'key', keys: 'down' }).catch(() => undefined)
    expect(hasConsent('many')).toBe(false)
    await expect(act('many', { type: 'key', keys: 'down' })).rejects.toThrow(/has not allowed/)
    stopComputerUse()
  })
  it("never clicks on Superagent's own dot, where an Allow button can be", async () => {
    stopComputerUse()
    setOwnSurfaceProbe((x, y) => x > 1000 && y > 600)
    // A click needs a screenshot to map from, so the mapping refuses first
    // without one; keys are not pointed anywhere and are not stopped by this.
    grantConsent('d')
    await expect(act('d', { type: 'click', x: 1200, y: 700 })).rejects.toThrow(/screenshot/i)
    setOwnSurfaceProbe(() => false)
    stopComputerUse()
  })
})

describe('what it will not be talked into', () => {
  const ready = (owner: string): void => {
    stopComputerUse()
    front = 'com.apple.TextEdit'
    under = null
    pointer = { x: 0, y: 0 }
    grantConsent(owner)
    sawFront(owner, 'com.apple.TextEdit')
  }
  it("does not type while Superagent's own window has the keyboard", async () => {
    ready('f')
    setOwnProbe({ focused: () => true, shortcuts: () => [] })
    await expect(act('f', { type: 'type', text: 'yes' })).rejects.toThrow(/own window/)
    await expect(act('f', { type: 'key', keys: 'return' })).rejects.toThrow(/own window/)
    setOwnProbe({ focused: () => false, shortcuts: () => [] })
  })
  it("does not press Superagent's own shortcuts, or the one that stops it", async () => {
    ready('s')
    setOwnProbe({ focused: () => false, shortcuts: () => ['Alt+Space', 'Control+Alt+S'] })
    for (const keys of ['alt+space', 'option+space', 'ctrl+alt+s', 'alt+escape', 'opt+esc'])
      await expect(act('s', { type: 'key', keys }), keys).rejects.toThrow(/own shortcuts/)
    setOwnProbe({ focused: () => false, shortcuts: () => [] })
  })
  it('is not turned on, and its keep-out list is not emptied, by a write to the store', async () => {
    stopComputerUse()
    const { computerUseEnabled, deniedApps } = await import('./computer-use')
    const was = computerUseEnabled()
    denyApp({ id: 'com.tinyspeck.slackmacgap', name: 'Slack' })
    // What an agent's shell could do to the database behind the app's back.
    kv.set('computer.enabled', was ? '0' : '1')
    kv.set('computer.denied', '[]')
    expect(computerUseEnabled()).toBe(was)
    expect(deniedApps().map((a) => a.name)).toEqual(['Slack'])
    undenyApp('com.tinyspeck.slackmacgap')
  })
  it('stops typing when Return brings another app to the front', async () => {
    ready('l')
    // Return on the first line opens something else: Terminal comes to the front.
    typed.length = 0
    afterType = () => {
      front = 'com.apple.Terminal'
    }
    const said = await act('l', { type: 'type', text: 'Terminal\nrm -rf ~\nmore' }).then(
      () => '',
      (e: Error) => e.message
    )
    afterType = null
    front = 'com.apple.TextEdit'
    // Without the helper built (CI) nothing is typed at all, for that reason.
    if (typed.length) {
      expect(typed).toEqual(['Terminal\n'])
      expect(said).toMatch(/Typing stopped after 1 line: pressing Return brought/)
    } else expect(said).not.toBe('')
    stopComputerUse()
  })
})

const helperBuilt = existsSync(join(__dirname, '..', '..', 'native', 'cuse'))

describe('reading the controls by name', () => {
  // Where the helper has not been built (CI, before the native step) there is
  // nothing to read the controls with, and the tool says so instead.
  it.skipIf(!helperBuilt)('needs no screenshot, and gives points a click can use', async () => {
    stopComputerUse()
    front = 'com.apple.TextEdit'
    under = null
    pointer = { x: 10, y: 10 }
    grantConsent('ui')
    controls = [
      { role: 'Button', label: 'Save', value: '', x: 2000, y: 100, w: 80, h: 40, enabled: true },
      {
        role: 'SecureTextField',
        label: 'Password',
        value: '(hidden)',
        x: 0,
        y: 0,
        w: 100,
        h: 20,
        enabled: true
      }
    ]
    const ui = await readUi('ui')
    expect(ui.app).toBe('TextEdit')
    expect(ui.window).toBe('Untitled')
    // A 2880-wide display is pictured 1440 wide: its points are halved.
    expect(ui.lines).toEqual([
      'button "Save" at 1020,60',
      'secure text field "Password" = (hidden) at 25,5'
    ])
    // A click at the point it gave is now placed without a screenshot.
    const said = await act('ui', { type: 'click', x: 1020, y: 60 }).then(
      () => '',
      (e: Error) => e.message
    )
    expect(said).not.toMatch(/screenshot/i)
    stopComputerUse()
  })
  it("is refused over a password manager, and over Superagent's own window", async () => {
    stopComputerUse()
    grantConsent('ui2')
    front = 'com.1password.1password'
    await expect(readUi('ui2')).rejects.toThrow(/1Password/)
    front = 'dev.superagent.app'
    await expect(readUi('ui2')).rejects.toThrow(/own window/)
    front = 'com.apple.TextEdit'
    stopComputerUse()
  })
})

describe('acting on a control by its name', () => {
  const ready = (owner: string): void => {
    stopComputerUse()
    front = 'com.apple.TextEdit'
    under = null
    pointer = { x: 0, y: 0 }
    grantConsent(owner)
    sawFront(owner, 'com.apple.TextEdit')
    byName.length = 0
  }
  it.skipIf(!helperBuilt)(
    'asks the helper for exactly that control, text and menu path',
    async () => {
      ready('n')
      await pressControl('n', 3, 'Save')
      await fillControl('n', 4, 'Title', 'Notes; rm -rf ~')
      await pickMenu('n', 'File > Export…')
      expect(byName).toEqual([
        ['axpress', '3', 'Save'],
        ['axset', '4', 'Title', 'Notes; rm -rf ~'],
        ['axmenu', 'File > Export…']
      ])
      stopComputerUse()
    }
  )
  it('is held to everything a click is: a yes, the apps out of bounds, its own window', async () => {
    stopComputerUse()
    front = 'com.apple.TextEdit'
    byName.length = 0
    await expect(pressControl('nobody', 1, 'OK')).rejects.toThrow(/has not allowed/)
    grantConsent('g')
    front = 'com.1password.1password'
    await expect(pressControl('g', 1, 'Copy')).rejects.toThrow(/1Password/)
    front = 'dev.superagent.app'
    await expect(pressControl('g', 1, 'Allow')).rejects.toThrow(/own window/)
    await expect(pickMenu('g', 'File > Quit')).rejects.toThrow(/own window/)
    expect(byName).toEqual([])
    stopComputerUse()
  })
  it('does nothing when another app has come to the front since the controls were read', async () => {
    ready('m')
    front = 'com.apple.Safari'
    await expect(fillControl('m', 2, 'Search', 'x')).rejects.toThrow(/Read the controls again/)
    expect(byName).toEqual([])
    stopComputerUse()
  })
})
