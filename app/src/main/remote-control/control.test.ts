import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppRef, LaidWindow } from '../../shared/computer-use'
import type { RemoteInputAction, ServerFrame, WireRemote } from '../../shared/companion-protocol'
import {
  REMOTE_ASK_MS,
  REMOTE_IDLE_MS,
  REMOTE_LOCKOUT_MS,
  REMOTE_MAX_MS,
  REMOTE_SILENT_MS
} from '../../shared/remote-control'
import {
  RemoteControl,
  RemoteRefusal,
  textPieces,
  type DisplayInfo,
  type RemoteDeps
} from './control'
import type { Bitmap } from './stream'

/**
 * Remote control with no Mac under it: every dependency is a fake, the clock is
 * vitest's, and "the helper" is a list of what it was asked to post. Nothing
 * here can move a real pointer or press a real key.
 */

const NOTES: AppRef = { id: 'com.apple.Notes', name: 'Notes' }
const SELF: AppRef = { id: 'dev.superagent.app', name: 'Superagent' }
const DEV_SELF: AppRef = { id: 'com.github.electron', name: 'Electron' }
const ONEPW: AppRef = { id: 'com.1password.1password', name: '1Password' }
const KEYCHAIN: AppRef = { id: 'com.apple.keychainaccess', name: 'Keychain Access' }
const LOGIN: AppRef = { id: 'com.apple.loginwindow', name: 'loginwindow' }
const DISPLAY: DisplayInfo = {
  id: 7,
  name: 'Main display',
  bounds: { x: 0, y: 0, width: 1000, height: 500 }
}
const WHO = { connId: 'c1', deviceId: 'd1', deviceName: "Pung's iPhone" }

const win = (app: AppRef | null, x = 0, y = 0, w = 1000, h = 500, layer = 0): LaidWindow => ({
  app,
  owner: app?.name ?? 'Window Server',
  layer,
  frame: { x, y, width: w, height: h }
})

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function make() {
  const w = {
    calls: [] as string[][],
    logs: [] as string[],
    frames: [] as ServerFrame[],
    pushes: [] as WireRemote[],
    front: NOTES as AppRef | null,
    under: null as AppRef | null,
    windows: [win(NOTES)] as LaidWindow[],
    layoutThrows: false,
    ownFocused: false,
    ownSurface: false,
    denied: [] as AppRef[],
    ownShortcuts: ['CommandOrControl+Shift+Space'],
    alive: true,
    ready: null as string | null,
    backlog: 0,
    bannerUp: false,
    bannerCalls: 0,
    bannerWorks: true,
    stopHeld: false,
    stopWorks: true,
    killed: 0,
    displays: [DISPLAY],
    asks: [] as ((a: { allow: false } | { allow: true; displayId: number }) => void)[],
    askSignals: [] as AbortSignal[],
    codes: [] as string[],
    codeSignals: [] as AbortSignal[],
    codeClosers: [] as (() => void)[],
    cursor: { x: 100, y: 50 } as { x: number; y: number } | null,
    captures: 0,
    captureThrows: false,
    pictures: [] as Bitmap[],
    sceneAfterCapture: null as null | (() => void),
    runFails: false,
    rand: 424242
  }
  const deps: RemoteDeps = {
    now: () => Date.now(),
    below: () => w.rand,
    send: (_c, f) => void w.frames.push(f),
    pushAll: (wire) => void w.pushes.push(wire('c1')),
    alive: () => w.alive,
    backlog: () => w.backlog,
    askAllow: ({ signal }) =>
      new Promise((resolve) => {
        w.askSignals.push(signal)
        w.asks.push(resolve)
        signal.addEventListener('abort', () => resolve({ allow: false }), { once: true })
      }),
    showCode: ({ code, signal }) =>
      new Promise<void>((resolve) => {
        w.codes.push(code)
        w.codeSignals.push(signal)
        w.codeClosers.push(resolve)
        signal.addEventListener('abort', () => resolve(), { once: true })
      }),
    displays: () => w.displays,
    notReady: () => w.ready,
    front: async () => w.front,
    layout: async () => {
      if (w.layoutThrows) throw new Error('no layout')
      return w.windows
    },
    appAt: async () => w.under,
    ownSurfaceAt: () => w.ownSurface,
    ownFocused: () => w.ownFocused,
    ownShortcuts: () => w.ownShortcuts,
    denied: () => w.denied,
    run: async (args) => {
      if (w.runFails) return { ok: false, error: 'the helper failed' }
      w.calls.push(args)
      return { ok: true, error: '' }
    },
    killRunning: () => void w.killed++,
    cursor: () => w.cursor,
    capture: async () => {
      w.captures++
      if (w.captureThrows) throw new Error('capture failed')
      const pic: Bitmap = { width: 200, height: 100, data: new Uint8Array(200 * 100 * 4).fill(255) }
      w.pictures.push(pic)
      w.sceneAfterCapture?.()
      return pic
    },
    encode: (_p, rect) => Buffer.alloc(Math.max(50, Math.round((rect.w * rect.h) / 20))),
    banner: {
      show: () => {
        w.bannerCalls++
        w.bannerUp = w.bannerWorks
        return w.bannerWorks
      },
      hide: () => void (w.bannerUp = false),
      ok: () => w.bannerUp
    },
    stopKey: {
      hold: () => {
        w.stopHeld = true
        return w.stopWorks
      },
      release: () => void (w.stopHeld = false)
    },
    log: (l) => void w.logs.push(l),
    changed: () => undefined
  }
  const c = new RemoteControl(deps)
  const flush = async (ms = 0): Promise<void> => void (await vi.advanceTimersByTimeAsync(ms))
  /** Ask, have the Mac's person allow it, and type the code the Mac shows. */
  const begin = async (): Promise<void> => {
    c.setEnabled(true)
    c.request(WHO)
    await flush()
    w.asks.shift()!({ allow: true, displayId: DISPLAY.id })
    await flush()
    c.code('c1', w.codes.at(-1)!)
    await flush()
  }
  /** Time passing with the phone still there: it says so every 20 seconds, as its ping does. */
  const wait = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= 20_000) {
      await flush(Math.min(20_000, left))
      if (c.wire('c1').state === 'active') c.view('c1', {})
    }
  }
  const input = (...a: RemoteInputAction[]): Promise<{ done: number }> => c.input('c1', a)
  const refused = async (p: Promise<unknown>): Promise<RemoteRefusal> => {
    try {
      await p
    } catch (e) {
      expect(e).toBeInstanceOf(RemoteRefusal)
      return e as RemoteRefusal
    }
    throw new Error('expected a refusal')
  }
  /** What the helper was asked to post (not looking, which posts nothing). */
  return { c, w, deps, flush, begin, input, refused, wait }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-01T12:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the switch', () => {
  it('is off until someone at the Mac turns it on: a request is refused and the phone is told nothing is there', async () => {
    const t = make()
    expect(t.c.isEnabled()).toBe(false)
    expect(t.c.wire('c1')).toEqual({ available: false, state: 'idle' })
    expect((await t.refused(Promise.resolve().then(() => t.c.request(WHO)))).reason).toBe('off')
    expect(t.w.asks).toHaveLength(0)
    expect(t.w.bannerCalls).toBe(0)
  })

  it('turning it on makes it available; the phone asks, nothing else happens', () => {
    const t = make()
    t.c.setEnabled(true)
    expect(t.c.wire('c1')).toMatchObject({ available: true, state: 'idle' })
    expect(t.w.pushes.at(-1)).toMatchObject({ available: true })
  })

  it('says why it cannot run when a permission is missing, and refuses the request', () => {
    const t = make()
    t.w.ready = 'Superagent does not have Screen Recording yet.'
    t.c.setEnabled(true)
    expect(t.c.wire('c1').note).toMatch(/Screen Recording/)
    expect(() => t.c.request(WHO)).toThrowError(/Screen Recording/)
  })

  it('turning it off ends a running session and cancels a request, at once', async () => {
    const t = make()
    await t.begin()
    expect(t.c.wire('c1').state).toBe('active')
    t.c.setEnabled(false)
    expect(t.c.wire('c1')).toEqual({ available: false, state: 'idle' })
    expect(t.w.bannerUp).toBe(false)
    expect(t.w.stopHeld).toBe(false)
    const u = make()
    u.c.setEnabled(true)
    u.c.request(WHO)
    await u.flush()
    u.c.setEnabled(false)
    expect(u.w.askSignals[0].aborted).toBe(true)
  })
})

describe('allowing a session, at the Mac', () => {
  it('asks the Mac, and nothing the phone sends can answer it', async () => {
    const t = make()
    t.c.setEnabled(true)
    expect(t.c.request(WHO).state).toBe('asking')
    await t.flush()
    expect(t.w.asks).toHaveLength(1)
    // The phone tries: a code before anyone allowed, input, a second request.
    expect(t.c.code('c1', '123456').state).toBe('asking')
    expect(t.w.codes).toHaveLength(0)
    await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))
    expect(() => t.c.request(WHO)).toThrowError(/already/)
    expect(t.c.wire('c1').state).toBe('asking')
    expect(t.w.calls).toEqual([])
    expect(t.w.bannerCalls).toBe(0)
  })

  it('a guess before the Mac allowed it costs nothing and is not a try', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    for (let i = 0; i < 10; i++) t.c.code('c1', '000000')
    t.w.asks.shift()!({ allow: true, displayId: DISPLAY.id })
    await t.flush()
    expect(t.c.wire('c1')).toMatchObject({ state: 'code', triesLeft: 3 })
  })

  it("'Don't allow' ends the request", async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: false })
    await t.flush()
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'denied' })
    expect(t.w.logs.some((l) => /not allowed \(denied\)/.test(l))).toBe(true)
    expect(t.w.bannerCalls).toBe(0)
  })

  it('after Allow, shows a six-digit code at the Mac; only that code starts the session', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: true, displayId: DISPLAY.id })
    await t.flush()
    expect(t.w.codes).toEqual(['424242'])
    expect(t.c.wire('c1')).toMatchObject({ state: 'code', triesLeft: 3 })
    expect(() => t.c.code('c1', '424243')).toThrowError(/2 tries left/)
    expect(t.c.wire('c1')).toMatchObject({ state: 'code', triesLeft: 2 })
    expect(t.w.bannerCalls).toBe(0)
    t.c.code('c1', '424242')
    expect(t.c.wire('c1')).toMatchObject({ state: 'active', display: { name: 'Main display' } })
    expect(t.w.bannerUp).toBe(true)
    expect(t.w.stopHeld).toBe(true)
    // The code dialog is gone once it has done its work.
    expect(t.w.codeSignals[0].aborted).toBe(true)
  })

  it('three wrong codes burn the request and close the code dialog', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: true, displayId: DISPLAY.id })
    await t.flush()
    expect(() => t.c.code('c1', '111111')).toThrow()
    expect(() => t.c.code('c1', '111111')).toThrow()
    expect(() => t.c.code('c1', '111111')).toThrowError(/third/)
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'wrong-code' })
    expect(t.w.codeSignals[0].aborted).toBe(true)
    // The right code afterwards is nothing: the request is gone.
    expect(() => t.c.code('c1', '424242')).toThrowError(/nothing to confirm/)
    expect(t.w.bannerCalls).toBe(0)
  })

  it('cancelling the code dialog at the Mac ends the request', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: true, displayId: DISPLAY.id })
    await t.flush()
    t.w.codeClosers[0]()
    await t.flush()
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'cancelled' })
  })

  it('a request nobody answers expires, and closes the dialog', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush(REMOTE_ASK_MS + 1)
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'expired' })
    expect(t.w.askSignals[0].aborted).toBe(true)
  })

  it('a code that sits for two minutes after Allow expires', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: true, displayId: DISPLAY.id })
    await t.flush(REMOTE_ASK_MS + 1)
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'expired' })
    expect(() => t.c.code('c1', '424242')).toThrow()
  })

  it('three turned-down requests lock requests out for a while, then it asks again', async () => {
    const t = make()
    t.c.setEnabled(true)
    for (let i = 0; i < 3; i++) {
      await t.flush(6000)
      t.c.request(WHO)
      await t.flush()
      t.w.asks.shift()!({ allow: false })
      await t.flush()
    }
    await t.flush(6000)
    expect(() => t.c.request(WHO)).toThrowError(/Too many/)
    await t.flush(REMOTE_LOCKOUT_MS + 10_000)
    expect(t.c.request(WHO).state).toBe('asking')
  })

  it('a phone cannot ask again within a few seconds', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: false })
    await t.flush()
    expect(() => t.c.request(WHO)).toThrowError(/Wait/)
    await t.flush(6000)
    expect(t.c.request(WHO).state).toBe('asking')
  })

  it('only one phone, and only that phone, can use the session', async () => {
    const t = make()
    await t.begin()
    expect(() => t.c.request({ ...WHO, connId: 'c2' })).toThrowError(/already/)
    await t.refused(t.c.input('c2', [{ type: 'click', x: 0.5, y: 0.5 }]))
    expect(() => t.c.view('c2', { visible: false })).toThrow()
    t.c.endFromPhone('c2')
    expect(t.c.wire('c1').state).toBe('active')
    expect(t.c.wire('c2').state).toBe('idle')
  })

  it('no banner, no session', async () => {
    const t = make()
    t.w.bannerWorks = false
    await t.begin()
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'banner-lost' })
    expect(t.w.stopHeld).toBe(false)
    await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))
  })

  it('no ⌥Esc, no session', async () => {
    const t = make()
    t.w.stopWorks = false
    await t.begin()
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'no-stop-key' })
    expect(t.w.bannerUp).toBe(false)
    expect(t.w.bannerCalls).toBe(0)
  })

  it('the display chosen at the Mac is the one shared; if it has gone by then, nothing starts', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: true, displayId: DISPLAY.id })
    await t.flush()
    t.w.displays = []
    t.c.code('c1', '424242')
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'display-gone' })
  })

  it('the name in the dialog is made safe', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request({ ...WHO, deviceName: 'Evil\nAllow it now\u0000' + 'x'.repeat(200) })
    await t.flush()
    expect(t.w.logs[0]).not.toMatch(/\n/)
    expect(t.w.logs[0].length).toBeLessThan(120)
  })
})

describe('while a session runs, and how it ends', () => {
  const ended = (t: ReturnType<typeof make>, why: string): void => {
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: why })
    expect(t.w.bannerUp).toBe(false)
    expect(t.w.stopHeld).toBe(false)
    expect(t.w.killed).toBeGreaterThan(0)
  }

  it('⌥Esc ends it at once', async () => {
    const t = make()
    await t.begin()
    t.c.end('hotkey')
    ended(t, 'hotkey')
  })

  it("the banner's Stop at the Mac, and End on the phone, end it", async () => {
    const a = make()
    await a.begin()
    a.c.end('stopped-at-mac')
    ended(a, 'stopped-at-mac')
    const b = make()
    await b.begin()
    b.c.endFromPhone('c1')
    ended(b, 'stopped-on-phone')
  })

  it('ends when the phone disconnects, at once, and when it goes quiet', async () => {
    const a = make()
    await a.begin()
    a.c.connGone('c1')
    ended(a, 'phone-left')
    const b = make()
    await b.begin()
    b.w.alive = false
    await b.flush(1100)
    ended(b, 'phone-left')
    const c = make()
    await c.begin()
    await c.flush(REMOTE_SILENT_MS + 2000)
    ended(c, 'phone-silent')
  })

  it('ends after ten minutes without input, then has to be allowed at the Mac again', async () => {
    const t = make()
    await t.begin()
    await t.wait(REMOTE_IDLE_MS - 60_000)
    expect(t.c.wire('c1').state).toBe('active')
    await t.input({ type: 'move', x: 0.2, y: 0.2 })
    await t.wait(REMOTE_IDLE_MS - 60_000)
    expect(t.c.wire('c1').state).toBe('active')
    await t.wait(2 * 60_000)
    ended(t, 'idle')
    await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))
    // A new session starts from the question at the Mac, not from where this one was.
    t.w.asks.length = 0
    await t.flush(10_000)
    t.c.request(WHO)
    await t.flush()
    expect(t.w.asks).toHaveLength(1)
    expect(t.c.wire('c1').state).toBe('asking')
  })

  it('refused input is not activity: a phone that only tries is idle all the same', async () => {
    const t = make()
    await t.begin()
    t.w.front = ONEPW
    for (let i = 0; i < 40 && t.c.wire('c1').state === 'active'; i++) {
      await t.wait(20_000)
      if (t.c.wire('c1').state === 'active')
        await t.refused(t.input({ type: 'move', x: 0.2, y: 0.2 }))
    }
    ended(t, 'idle')
  })

  it('ends after two hours however busy it is', async () => {
    const t = make()
    await t.begin()
    for (let i = 0; i < REMOTE_MAX_MS / 20_000 + 5 && t.c.wire('c1').state === 'active'; i++) {
      await t.wait(20_000)
      if (t.c.wire('c1').state === 'active') await t.input({ type: 'move', x: 0.1, y: 0.1 })
    }
    ended(t, 'too-long')
  })

  it('ends when the Mac sleeps or locks, when the banner is lost, when the display goes, when a permission is taken', async () => {
    for (const [why, cut] of [
      ['slept', (t: ReturnType<typeof make>) => t.c.end('slept')],
      ['locked', (t: ReturnType<typeof make>) => t.c.end('locked')],
      [
        'banner-lost',
        async (t: ReturnType<typeof make>) => {
          t.w.bannerUp = false
          await t.flush(1100)
        }
      ],
      [
        'display-gone',
        async (t: ReturnType<typeof make>) => {
          t.w.displays = []
          await t.flush(1100)
        }
      ],
      [
        'permissions',
        async (t: ReturnType<typeof make>) => {
          t.w.ready = 'Screen Recording was taken away'
          await t.flush(1100)
        }
      ]
    ] as const) {
      const t = make()
      await t.begin()
      await cut(t)
      ended(t, why)
    }
  })

  it('lets go of a button the phone was holding, where it went down', async () => {
    const t = make()
    await t.begin()
    await t.input({ type: 'down', x: 0.5, y: 0.5 })
    t.w.calls.length = 0
    t.c.end('stopped-on-phone')
    await t.flush()
    expect(t.w.calls).toEqual([['up', '500', '250', 'left']])
  })

  it('anything still queued when it ends is dropped, not posted afterwards', async () => {
    const t = make()
    await t.begin()
    const slow = t.input({ type: 'click', x: 0.1, y: 0.1 }, { type: 'click', x: 0.2, y: 0.2 })
    t.c.end('hotkey')
    await t.refused(slow)
    await t.flush()
    expect(t.w.calls.filter((c) => c[0] === 'tap').length).toBeLessThan(2)
    t.w.calls.length = 0
    await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))
    expect(t.w.calls).toEqual([])
  })

  it('writes the start, the end and every refusal to the log, never what was typed', async () => {
    const t = make()
    await t.begin()
    await t.input({ type: 'text', text: 'hunter2-my-password' })
    await t.input({ type: 'key', key: 'p' })
    t.w.front = ONEPW
    await t.refused(t.input({ type: 'text', text: 'hunter2-my-password' }))
    await t.refused(t.input({ type: 'key', key: 'h' }))
    t.c.end('hotkey')
    const log = t.w.logs.join('\n')
    expect(log).toMatch(/session started for "Pung's iPhone" on display "Main display"/)
    expect(log).toMatch(/refused text \(secret\)/)
    expect(log).toMatch(/session ended \(hotkey\)/)
    expect(log).not.toMatch(/hunter2/)
    expect(log).not.toMatch(/my-password/)
  })

  it('logs a wrong code and a refused request', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: false })
    await t.flush()
    expect(t.w.logs.join('\n')).toMatch(/request from "Pung's iPhone"/)
    expect(t.w.logs.join('\n')).toMatch(/not allowed \(denied\)/)
  })
})

describe('input: applied in order, through the helper, only where it is safe', () => {
  it('a batch is applied in the order sent, each as one helper call with its points mapped', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    await t.input(
      { type: 'click', x: 0.1, y: 0.2 },
      { type: 'key', key: 'a', mods: ['cmd'] },
      { type: 'text', text: 'hi' },
      { type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 },
      { type: 'click', x: 1, y: 1, button: 'right', count: 2 }
    )
    expect(t.w.calls).toEqual([
      ['tap', '100', '100', 'left', '1'],
      ['key', 'cmd+a'],
      ['type', 'hi'],
      ['wheel', '500', '250', '0', '50'],
      ['tap', '999', '499', 'right', '2']
    ])
  })

  it('hold, move and let go is a drag: the move becomes dragto only while held', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    await t.input(
      { type: 'move', x: 0.1, y: 0.1 },
      { type: 'down', x: 0.1, y: 0.1 },
      { type: 'move', x: 0.3, y: 0.3 },
      { type: 'up', x: 0.3, y: 0.3 },
      { type: 'move', x: 0.5, y: 0.5 }
    )
    expect(t.w.calls.map((c) => c[0])).toEqual(['jump', 'down', 'dragto', 'up', 'jump'])
  })

  it('a run of moves is only the last of them', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    await t.input(
      { type: 'move', x: 0.1, y: 0.1 },
      { type: 'move', x: 0.2, y: 0.2 },
      { type: 'move', x: 0.3, y: 0.3 }
    )
    expect(t.w.calls).toEqual([['jump', '300', '150']])
  })

  it('a batch stops at the first refusal; the rest is not done', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    const p = t.input(
      { type: 'click', x: 0.1, y: 0.1 },
      { type: 'key', key: 'escape', mods: ['cmd', 'opt'] },
      { type: 'click', x: 0.9, y: 0.9 }
    )
    expect((await t.refused(p)).reason).toBe('blocked-key')
    expect(t.w.calls).toEqual([['tap', '100', '50', 'left', '1']])
  })

  it('refuses a flood, and keeps going afterwards', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    let refusedN = 0
    for (let i = 0; i < 400; i++) {
      try {
        await t.input({ type: 'click', x: 0.5, y: 0.5 })
      } catch (e) {
        if ((e as RemoteRefusal).reason === 'rate-limited') refusedN++
      }
    }
    expect(refusedN).toBeGreaterThan(150)
    expect(t.w.calls.length).toBeLessThan(250)
    await t.flush(2000)
    await t.input({ type: 'click', x: 0.5, y: 0.5 })
    expect(t.w.calls.at(-1)).toEqual(['tap', '500', '250', 'left', '1'])
  })

  it('when the helper fails, says so and does not pretend', async () => {
    const t = make()
    await t.begin()
    t.w.runFails = true
    expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))).reason).toBe('failed')
  })

  describe('never into a secret', () => {
    for (const [name, app, reason] of [
      ['1Password', ONEPW, 'secret'],
      ['Keychain Access', KEYCHAIN, 'secret'],
      ['the lock screen', LOGIN, 'lock'],
      ['a macOS password prompt', { id: 'name:SecurityAgent', name: 'SecurityAgent' }, 'secret'],
      ['an app on the keep-out list', { id: 'com.acme.vault', name: 'Vault' }, 'secret']
    ] as const) {
      it(`refuses everything while ${name} is in front, and posts nothing`, async () => {
        const t = make()
        t.w.denied = [{ id: 'com.acme.vault', name: 'Vault' }]
        await t.begin()
        t.w.calls.length = 0
        t.w.front = app
        for (const a of [
          { type: 'click', x: 0.5, y: 0.5 },
          { type: 'move', x: 0.5, y: 0.5 },
          { type: 'text', text: 'x' },
          { type: 'key', key: 'return' },
          { type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 },
          { type: 'drag', x: 0.1, y: 0.1, toX: 0.2, toY: 0.2 }
        ] as RemoteInputAction[])
          expect((await t.refused(t.input(a))).reason).toBe(reason)
        expect(t.w.calls).toEqual([])
      })
    }

    it('refuses a click on a secret window under the pointer even when another app is in front', async () => {
      const t = make()
      await t.begin()
      t.w.calls.length = 0
      t.w.under = ONEPW
      expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))).reason).toBe('secret')
      // And the far end of a drag.
      t.w.under = NOTES
      await t.input({ type: 'move', x: 0.1, y: 0.1 })
      expect(t.w.calls).toHaveLength(1)
    })

    it('refuses when the Mac will not say what is in front', async () => {
      const t = make()
      await t.begin()
      t.w.front = null
      expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))).reason).toBe('unknown')
      expect(t.w.calls).toEqual([])
    })

    it('picks up the keep-out list as it is now, not as it was when the session began', async () => {
      const t = make()
      await t.begin()
      await t.input({ type: 'click', x: 0.5, y: 0.5 })
      t.w.denied = [NOTES]
      expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))).reason).toBe('secret')
    })

    it('typed text goes in pieces, and stops when a secret comes to the front part-way', async () => {
      const t = make()
      await t.begin()
      t.w.calls.length = 0
      const text = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP'
      let runs = 0
      const run = t.deps.run
      t.deps.run = async (args) => {
        const r = await run(args)
        if (args[0] === 'type' && ++runs === 1) t.w.front = ONEPW
        return r
      }
      expect((await t.refused(t.input({ type: 'text', text }))).reason).toBe('secret')
      expect(t.w.calls).toEqual([['type', text.slice(0, 24)]])
    })
  })

  describe("never into Superagent's own windows", () => {
    for (const self of [SELF, DEV_SELF]) {
      it(`refuses every action while ${self.id} is in front, so the phone cannot answer its own prompts`, async () => {
        const t = make()
        await t.begin()
        t.w.calls.length = 0
        t.w.front = self
        for (const a of [
          { type: 'click', x: 0.5, y: 0.5 },
          { type: 'key', key: 'return' },
          { type: 'key', key: 'space' },
          { type: 'text', text: 'yes' }
        ] as RemoteInputAction[])
          expect((await t.refused(t.input(a))).reason).toBe('own-window')
        expect(t.w.calls).toEqual([])
      })
    }

    it("refuses a click on a window of Superagent's under the pointer, whatever is in front (a dialog, the banner, Settings)", async () => {
      const t = make()
      await t.begin()
      t.w.calls.length = 0
      t.w.under = SELF
      expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))).reason).toBe(
        'own-window'
      )
      expect(
        (await t.refused(t.input({ type: 'drag', x: 0.1, y: 0.1, toX: 0.2, toY: 0.2 }))).reason
      ).toBe('own-window')
      expect(t.w.calls).toEqual([])
    })

    it("refuses a point inside one of Superagent's floating windows (the dot, the banner)", async () => {
      const t = make()
      await t.begin()
      t.w.ownSurface = true
      expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))).reason).toBe(
        'own-window'
      )
      expect((await t.refused(t.input({ type: 'move', x: 0.5, y: 0.5 }))).reason).toBe('own-window')
      expect(t.w.calls).toEqual([])
    })

    it('refuses keys and text while one of its windows holds the keyboard, even when another app is in front', async () => {
      const t = make()
      await t.begin()
      t.w.ownFocused = true
      expect((await t.refused(t.input({ type: 'key', key: 'return' }))).reason).toBe('own-window')
      expect((await t.refused(t.input({ type: 'text', text: 'a' }))).reason).toBe('own-window')
      expect(t.w.calls).toEqual([])
    })

    it("refuses Superagent's own shortcuts, so it cannot be opened from the phone", async () => {
      const t = make()
      await t.begin()
      expect(
        (await t.refused(t.input({ type: 'key', key: 'space', mods: ['cmd', 'shift'] }))).reason
      ).toBe('blocked-key')
      expect(t.w.calls).toEqual([])
    })
  })

  describe('never the keys that get round the rest', () => {
    for (const [name, a] of [
      ['⌥Esc, which stops it', { type: 'key', key: 'escape', mods: ['opt'] }],
      ['⌘⌥Esc, which opens Force Quit', { type: 'key', key: 'escape', mods: ['cmd', 'opt'] }],
      [
        '⇧⌘Q, which logs out and closes Superagent',
        { type: 'key', key: 'q', mods: ['cmd', 'shift'] }
      ],
      ['⌥⇧⌘Q, which logs out at once', { type: 'key', key: 'q', mods: ['cmd', 'opt', 'shift'] }]
    ] as const) {
      it(`refuses ${name}`, async () => {
        const t = make()
        await t.begin()
        expect((await t.refused(t.input(a as unknown as RemoteInputAction))).reason).toBe(
          'blocked-key'
        )
        expect(t.w.calls).toEqual([])
      })
    }
    it('lets through Spotlight, Mission Control and App Windows, and ordinary keys', async () => {
      const t = make()
      await t.begin()
      t.w.calls.length = 0
      await t.input(
        { type: 'key', key: 'space', mods: ['cmd'] },
        { type: 'key', key: 'up', mods: ['ctrl'] },
        { type: 'key', key: 'down', mods: ['ctrl'] },
        { type: 'key', key: 'tab', mods: ['cmd'] },
        { type: 'key', key: 'z', mods: ['cmd'] },
        { type: 'key', key: 'z', mods: ['cmd', 'shift'] }
      )
      expect(t.w.calls.map((c) => c[1])).toEqual([
        'cmd+space',
        'ctrl+up',
        'ctrl+down',
        'cmd+tab',
        'cmd+z',
        'cmd+shift+z'
      ])
    })
  })
})

describe('the stream', () => {
  it('sends pictures while a session runs, and the first is a whole one', async () => {
    const t = make()
    await t.begin()
    await t.flush(300)
    const screens = t.w.frames.filter((f) => f.t === 'screen')
    expect(screens.length).toBeGreaterThan(0)
    expect(screens[0]).toMatchObject({
      t: 'screen',
      frame: { key: true, x: 0, y: 0, w: 200, h: 100 }
    })
    // The pointer is on the shared display: where it is, as a fraction of it.
    expect(screens[0]).toMatchObject({ frame: { cursor: { x: 0.1, y: 0.1 } } })
  })

  it('a still screen costs no pictures after the first, only a cursor that moved', async () => {
    const t = make()
    await t.begin()
    await t.flush(2000)
    const jpegs = t.w.frames.filter((f) => f.t === 'screen' && f.frame.jpeg !== '')
    expect(jpegs).toHaveLength(1)
    t.w.cursor = { x: 500, y: 250 }
    await t.flush(1000)
    const last = t.w.frames.at(-1)
    expect(last).toMatchObject({
      t: 'screen',
      frame: { jpeg: '', rw: 0, cursor: { x: 0.5, y: 0.5 } }
    })
  })

  it('reports no cursor when the Mac pointer is on another display', async () => {
    const t = make()
    t.w.cursor = { x: 5000, y: 5000 }
    await t.begin()
    await t.flush(300)
    expect(t.w.frames.find((f) => f.t === 'screen')).toMatchObject({ frame: { cursor: null } })
  })

  it("covers Superagent's own windows, so the phone never sees its dialogs, banner or Settings", async () => {
    const t = make()
    t.w.windows = [win(SELF, 100, 100, 50, 25, 8), win(NOTES)]
    await t.begin()
    await t.flush(300)
    const pic = t.w.pictures[0]
    const px = (x: number, y: number): number => pic.data[(y * pic.width + x) * 4]
    // The display is 1000x500 and the picture 200x100: a fifth. Superagent's
    // window is at 20..30 across, 20..25 down in the picture.
    expect(px(25, 22)).toBe(0x2b)
    expect(px(5, 5)).toBe(255)
    expect(px(60, 60)).toBe(255)
  })

  it('shows another app that is in front of Superagent', async () => {
    const t = make()
    t.w.windows = [win(NOTES, 0, 0, 1000, 500), win(SELF, 100, 100, 200, 100)]
    await t.begin()
    await t.flush(300)
    const pic = t.w.pictures[0]
    expect(pic.data[(22 * pic.width + 25) * 4]).toBe(255)
  })

  for (const [name, app, why] of [
    ['a password manager', ONEPW, 'secret'],
    ['Keychain Access', KEYCHAIN, 'secret'],
    ['the lock screen', LOGIN, 'lock']
  ] as const) {
    it(`pauses, sends no picture and refuses input while ${name} is in front, and picks up again after`, async () => {
      const t = make()
      await t.begin()
      await t.flush(300)
      t.w.frames.length = 0
      t.w.captures = 0
      t.w.front = app
      t.w.windows = [win(app), win(NOTES)]
      await t.flush(1500)
      expect(t.c.wire('c1')).toMatchObject({ state: 'active', paused: why })
      expect(t.w.captures).toBe(0)
      expect(t.w.frames.filter((f) => f.t === 'screen')).toHaveLength(0)
      t.w.calls.length = 0
      expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))).reason).toBe('paused')
      expect(t.w.calls).toEqual([])
      // Back to the notes: a whole picture again, and input works.
      t.w.front = NOTES
      t.w.windows = [win(NOTES)]
      await t.flush(1500)
      expect(t.c.wire('c1').paused).toBeNull()
      expect(t.w.frames.find((f) => f.t === 'screen')).toMatchObject({ frame: { key: true } })
      await t.input({ type: 'click', x: 0.5, y: 0.5 })
    })
  }

  it('pauses when a password manager is on the shared display even if it is not in front', async () => {
    const t = make()
    await t.begin()
    t.w.windows = [win(NOTES), win(ONEPW, 600, 100, 300, 300)]
    await t.flush(1500)
    expect(t.c.wire('c1')).toMatchObject({ paused: 'secret', pausedBy: '1Password' })
  })

  it('does not pause for a password manager on another display', async () => {
    const t = make()
    await t.begin()
    t.w.windows = [win(NOTES), win(ONEPW, 5000, 0, 300, 300)]
    await t.flush(1500)
    expect(t.c.wire('c1').paused).toBeNull()
  })

  it('pauses for an app on the keep-out list, and when the windows cannot be listed', async () => {
    const t = make()
    t.w.denied = [{ id: 'com.acme.vault', name: 'Vault' }]
    await t.begin()
    t.w.windows = [win(NOTES), win({ id: 'com.acme.vault', name: 'Vault' }, 0, 0, 100, 100)]
    await t.flush(1500)
    expect(t.c.wire('c1')).toMatchObject({ paused: 'secret', pausedBy: 'Vault' })
    const u = make()
    await u.begin()
    u.w.layoutThrows = true
    await u.flush(1500)
    expect(u.c.wire('c1').paused).toBe('unknown')
  })

  it('throws a picture away when a secret came to the front while it was being taken', async () => {
    const t = make()
    await t.begin()
    await t.flush(300)
    t.w.frames.length = 0
    t.w.windows = [win(NOTES)]
    t.w.cursor = { x: 1, y: 1 }
    t.w.sceneAfterCapture = () => {
      t.w.front = ONEPW
      t.w.windows = [win(ONEPW)]
    }
    await t.flush(1500)
    expect(t.w.frames.filter((f) => f.t === 'screen')).toHaveLength(0)
    expect(t.c.wire('c1').paused).toBe('secret')
  })

  it('waits while the relay is behind, instead of piling frames on it', async () => {
    const t = make()
    t.w.backlog = 10_000_000
    await t.begin()
    await t.flush(5000)
    expect(t.w.captures).toBe(0)
    t.w.backlog = 0
    await t.flush(3000)
    expect(t.w.captures).toBeGreaterThan(0)
  })

  it('stops capturing while the phone is not showing the screen, and starts again with a whole picture', async () => {
    const t = make()
    await t.begin()
    await t.flush(300)
    t.c.view('c1', { visible: false })
    await t.flush(1000)
    const n = t.w.captures
    await t.flush(3000)
    expect(t.w.captures).toBe(n)
    t.w.frames.length = 0
    t.c.view('c1', { visible: true })
    await t.flush(300)
    expect(t.w.frames.find((f) => f.t === 'screen')).toMatchObject({ frame: { key: true } })
  })

  it('gives up when the screen cannot be captured, which macOS reports as granted until a restart', async () => {
    const t = make()
    t.w.captureThrows = true
    await t.begin()
    await t.flush(5000)
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'permissions' })
    expect(t.w.bannerUp).toBe(false)
  })

  it('a phone-requested width caps the picture', async () => {
    const t = make()
    await t.begin()
    t.c.view('c1', { maxWidth: 640 })
    await t.flush(300)
    expect(t.c.wire('c1').state).toBe('active')
  })
})

describe('text pieces', () => {
  it('never split a character', () => {
    expect(textPieces('a'.repeat(50)).map((p) => p.length)).toEqual([24, 24, 2])
    expect(textPieces('👋'.repeat(30)).join('')).toBe('👋'.repeat(30))
    expect(textPieces('👋'.repeat(30))[0]).toBe('👋'.repeat(24))
    expect(textPieces('')).toEqual([])
  })
})
