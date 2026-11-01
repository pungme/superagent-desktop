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
const CALLER = { connId: 'c1', deviceId: 'd1' }
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
    /** The app in front changes to this at a time, as macOS does a moment after a key. */
    frontLater: null as null | { at: number; app: AppRef },
    /** Every reading of the app in front is the next of these (it never settles). */
    frontFlips: null as null | AppRef[],
    /** The flips start once this many helper calls were made. */
    flipFrom: 0,
    frontReads: 0,
    askQs: [] as { deviceName: string; shells: boolean }[],
    runError: '',
    appAtFails: false,
    clipboardSecret: false,
    bannerHiddenNow: false,
    /** How many helper runs Stop finds posting. */
    killRuns: 0,
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
    askAllow: ({ signal, deviceName, shells }) =>
      new Promise((resolve) => {
        w.askQs.push({ deviceName, shells })
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
    front: async () => {
      w.frontReads++
      if (w.frontFlips && w.calls.length >= w.flipFrom)
        return w.frontFlips[w.frontReads % w.frontFlips.length]
      return w.frontLater && Date.now() >= w.frontLater.at ? w.frontLater.app : w.front
    },
    layout: async () => {
      if (w.layoutThrows) throw new Error('no layout')
      return w.windows
    },
    appAt: async () => {
      if (w.appAtFails) throw new Error('the helper timed out')
      return w.under
    },
    clipboardConcealed: () => w.clipboardSecret,
    bannerHidden: () => w.bannerHiddenNow,
    ownSurfaceAt: () => w.ownSurface,
    ownFocused: () => w.ownFocused,
    ownShortcuts: () => w.ownShortcuts,
    denied: () => w.denied,
    run: async (args) => {
      if (w.runFails) return { ok: false, error: w.runError || 'the helper failed' }
      w.calls.push(args)
      return { ok: true, error: '' }
    },
    killRunning: () => (w.killed++, w.killRuns),
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
    c.code(CALLER, w.codes.at(-1)!)
    await flush()
  }
  /** Time passing with the phone still there: it says so every 20 seconds, as its ping does. */
  const wait = async (ms: number): Promise<void> => {
    for (let left = ms; left > 0; left -= 20_000) {
      await flush(Math.min(20_000, left))
      if (c.wire('c1').state === 'active') c.view(CALLER, {})
    }
  }
  /**
   * Time passes while it runs: after a click or a key that can change the app in
   * front, the next action waits for the Mac to settle (fake time here).
   */
  const running = async <T>(p: Promise<T>): Promise<T> => {
    let done = false
    const q = p.then(
      (v) => ((done = true), v),
      (e) => {
        done = true
        throw e
      }
    )
    q.catch(() => undefined)
    while (!done) await vi.advanceTimersByTimeAsync(50)
    return q
  }
  const input = (...a: RemoteInputAction[]): Promise<{ done: number }> =>
    running(c.input(CALLER, a))
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
  return { c, w, deps, flush, begin, input, refused, wait, running }
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
    expect(t.c.code(CALLER, '123456').state).toBe('asking')
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
    for (let i = 0; i < 10; i++) t.c.code(CALLER, '000000')
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
    expect(() => t.c.code(CALLER, '424243')).toThrowError(/2 tries left/)
    expect(t.c.wire('c1')).toMatchObject({ state: 'code', triesLeft: 2 })
    expect(t.w.bannerCalls).toBe(0)
    t.c.code(CALLER, '424242')
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
    expect(() => t.c.code(CALLER, '111111')).toThrow()
    expect(() => t.c.code(CALLER, '111111')).toThrow()
    expect(() => t.c.code(CALLER, '111111')).toThrowError(/third/)
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'wrong-code' })
    expect(t.w.codeSignals[0].aborted).toBe(true)
    // The right code afterwards is nothing: the request is gone.
    expect(() => t.c.code(CALLER, '424242')).toThrowError(/nothing to confirm/)
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
    expect(() => t.c.code(CALLER, '424242')).toThrow()
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

  it('the phone can withdraw a request that is waiting at the Mac: the dialogs close, no strike', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.c.endFromPhone(CALLER)
    expect(t.w.askSignals[0].aborted).toBe(true)
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'cancelled' })
    // Withdrawing is not being turned down: four of them lock nothing out.
    for (let i = 0; i < 4; i++) {
      await t.flush(6000)
      t.c.request(WHO)
      await t.flush()
      t.c.endFromPhone(CALLER)
    }
    await t.flush(6000)
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
    await t.refused(t.c.input({ ...CALLER, connId: 'c2' }, [{ type: 'click', x: 0.5, y: 0.5 }]))
    expect(() => t.c.view({ ...CALLER, connId: 'c2' }, { visible: false })).toThrow()
    t.c.endFromPhone({ ...CALLER, connId: 'c2' })
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
    t.c.code(CALLER, '424242')
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
    b.c.endFromPhone(CALLER)
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
    // Two simulated hours in 20-second steps: about 5 s here, more on a busy CI runner.
  }, 60_000)

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
    // Three hundred clicks sent at once, as a stuck or hostile phone would.
    const all = Array.from({ length: 300 }, () =>
      t.c.input(CALLER, [{ type: 'click', x: 0.5, y: 0.5 }]).then(
        () => 'done',
        (e: RemoteRefusal) => e.reason
      )
    )
    const results = await t.running(Promise.all(all))
    expect(results.filter((r) => r === 'rate-limited').length).toBeGreaterThan(150)
    expect(t.w.calls.length).toBeLessThan(100)
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
        const tried = [
          { type: 'click', x: 0.5, y: 0.5 },
          { type: 'move', x: 0.5, y: 0.5 },
          { type: 'text', text: 'x' },
          { type: 'key', key: 'return' },
          { type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 },
          { type: 'drag', x: 0.1, y: 0.1, toX: 0.2, toY: 0.2 }
        ] as RemoteInputAction[]
        // The first is refused by the guard itself; by the next the stream has
        // looked too and paused, which refuses just the same.
        expect((await t.refused(t.input(tried[0]))).reason).toBe(reason)
        for (const a of tried.slice(1))
          expect([reason, 'paused']).toContain((await t.refused(t.input(a))).reason)
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
      expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))).reason).toBe(
        why === 'lock' ? 'lock' : 'secret'
      )
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
    t.c.view(CALLER, { visible: false })
    await t.flush(1000)
    const n = t.w.captures
    await t.flush(3000)
    expect(t.w.captures).toBe(n)
    t.w.frames.length = 0
    t.c.view(CALLER, { visible: true })
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
    t.c.view(CALLER, { maxWidth: 640 })
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

// --- the security review's findings --------------------------------------------

const TERMINAL: AppRef = { id: 'com.apple.Terminal', name: 'Terminal' }
const SPOTLIGHT: AppRef = { id: 'com.apple.Spotlight', name: 'Spotlight' }
const SHELLS: AppRef[] = [
  TERMINAL,
  { id: 'com.googlecode.iterm2', name: 'iTerm2' },
  { id: 'dev.warp.Warp-Stable', name: 'Warp' },
  { id: 'com.mitchellh.ghostty', name: 'Ghostty' },
  { id: 'org.alacritty', name: 'Alacritty' },
  { id: 'com.microsoft.VSCode', name: 'Code' },
  { id: 'com.todesktop.230313mzl4w4u92', name: 'Cursor' },
  { id: 'dev.zed.Zed', name: 'Zed' },
  { id: 'com.apple.ScriptEditor2', name: 'Script Editor' },
  { id: 'com.apple.Automator', name: 'Automator' },
  { id: 'com.apple.shortcuts', name: 'Shortcuts' },
  { id: 'com.apple.ActivityMonitor', name: 'Activity Monitor' },
  { id: 'com.apple.Console', name: 'Console' }
]

describe('finding 1: no shell through the phone, unless allowed at the Mac', () => {
  for (const app of SHELLS) {
    it(`refuses every action while ${app.name} is in front, and posts nothing`, async () => {
      const t = make()
      await t.begin()
      t.w.calls.length = 0
      t.w.front = app
      const first = await t.refused(t.input({ type: 'text', text: 'security dump-keychain' }))
      expect(first.reason).toBe('shell')
      for (const a of [
        { type: 'click', x: 0.5, y: 0.5 },
        { type: 'key', key: 'return' },
        { type: 'key', key: 'c', mods: ['ctrl'] },
        { type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 }
      ] as RemoteInputAction[])
        expect(['shell', 'paused']).toContain((await t.refused(t.input(a))).reason)
      expect(t.w.calls).toEqual([])
    })
  }

  it("refuses a click on a shell's window under the pointer, whatever is in front", async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    t.w.under = TERMINAL
    expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.5 }))).reason).toBe('shell')
    expect(
      (await t.refused(t.input({ type: 'drag', x: 0.1, y: 0.1, toX: 0.2, toY: 0.2 }))).reason
    ).toBe('shell')
    expect(t.w.calls).toEqual([])
  })

  it('pauses the stream while a shell is in front, and covers one that is only on screen', async () => {
    const t = make()
    await t.begin()
    t.w.front = TERMINAL
    t.w.windows = [win(TERMINAL)]
    await t.flush(800)
    expect(t.c.wire('c1')).toMatchObject({ paused: 'secret', pausedBy: 'Terminal' })
    t.w.captures = 0
    await t.flush(2000)
    expect(t.w.captures).toBe(0)
    // Not in front: it is on screen behind Notes, and its window is covered.
    t.w.front = NOTES
    t.w.windows = [win(NOTES, 0, 0, 500, 500), win(TERMINAL, 500, 0, 500, 500)]
    await t.flush(2000)
    expect(t.c.wire('c1').paused).toBeNull()
    const pic = t.w.pictures.at(-1)!
    const at = (x: number, y: number): number => pic.data[(y * pic.width + x) * 4]
    expect(at(50, 50)).toBe(255) // Notes' half, as drawn
    expect(at(150, 50)).toBe(0x2b) // the terminal's half, greyed
  })

  it('is allowed once the Mac says so, and only then; turning remote control off turns it off again', async () => {
    const t = make()
    t.c.setEnabled(true)
    expect(t.c.shellsAllowed()).toBe(false)
    t.c.setShells(true)
    expect(t.c.shellsAllowed()).toBe(true)
    await t.begin()
    t.w.calls.length = 0
    t.w.front = TERMINAL
    await t.input({ type: 'text', text: 'ls' })
    expect(t.w.calls).toEqual([['type', 'ls']])
    t.c.setEnabled(false)
    expect(t.c.shellsAllowed()).toBe(false)
    // Off, nothing can switch it on.
    t.c.setShells(true)
    expect(t.c.shellsAllowed()).toBe(false)
  })

  it("tells the Mac's dialog whether shells are allowed, so it can say what the phone can do", async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    expect(t.w.askQs[0].shells).toBe(false)
    t.w.asks.shift()!({ allow: false })
    await t.flush(6000)
    t.c.setShells(true)
    t.c.request(WHO)
    await t.flush()
    expect(t.w.askQs[1].shells).toBe(true)
  })

  it('the Spotlight route: Return opens Terminal a moment later, and what is typed next is not delivered', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false }) // the stream's own looks are not what is measured
    t.w.calls.length = 0
    t.w.front = SPOTLIGHT
    // Terminal comes to the front 700 ms after Return, as a launching app does.
    const p = t.input(
      { type: 'text', text: 'Terminal' },
      { type: 'key', key: 'return' },
      { type: 'text', text: 'security dump-keychain' },
      { type: 'key', key: 'return' }
    )
    t.w.frontLater = { at: Date.now() + 700, app: TERMINAL }
    const e = await t.refused(p)
    expect(e.reason).toBe('shell')
    expect(t.w.calls).toEqual([
      ['type', 'Terminal'],
      ['key', 'return']
    ])
  })
})

describe('finding 2: a key does not race a change of the app in front', () => {
  it('cmd+tab, then Return: the Return is not delivered to the old app, nor to Superagent', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false }) // the stream's own looks are not what is measured
    t.w.calls.length = 0
    const p = t.input({ type: 'key', key: 'tab', mods: ['cmd'] }, { type: 'key', key: 'return' })
    // Superagent comes to the front 300 ms after the keys, late.
    t.w.frontLater = { at: Date.now() + 300, app: SELF }
    expect((await t.refused(p)).reason).toBe('own-window')
    expect(t.w.calls).toEqual([['key', 'cmd+tab']])
  })

  it("cmd+tab, then cmd+,: Superagent's Settings shortcut never reaches it", async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false }) // the stream's own looks are not what is measured
    t.w.calls.length = 0
    const p = t.input(
      { type: 'key', key: 'tab', mods: ['cmd'] },
      { type: 'key', key: ',', mods: ['cmd'] }
    )
    t.w.frontLater = { at: Date.now() + 300, app: SELF }
    expect((await t.refused(p)).reason).toBe('own-window')
    expect(t.w.calls).toEqual([['key', 'cmd+tab']])
  })

  it('a click that brings another app forward is waited out before the next action looks', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false }) // the stream's own looks are not what is measured
    t.w.calls.length = 0
    const p = t.input({ type: 'click', x: 0.5, y: 0.5 }, { type: 'text', text: 'secret' })
    t.w.frontLater = { at: Date.now() + 300, app: ONEPW }
    expect((await t.refused(p)).reason).toBe('secret')
    expect(t.w.calls).toEqual([['tap', '500', '250', 'left', '1']])
  })

  it('while the app in front will not settle, keys that switch apps are refused', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false }) // the stream's own looks are not what is measured
    t.w.calls.length = 0
    t.w.frontFlips = [NOTES, TERMINAL, SELF]
    await t.input({ type: 'key', key: 'tab', mods: ['cmd'] })
    t.w.flipFrom = 1
    const e = await t.refused(t.input({ type: 'key', key: 'a', mods: ['cmd'] }))
    expect(e.reason).toBe('settling')
    t.w.frontFlips = null
    // Once it holds still, it goes on.
    await t.input({ type: 'key', key: 'a', mods: ['cmd'] })
    expect(t.w.calls.at(-1)).toEqual(['key', 'cmd+a'])
  })

  it('plain typing and pointer moves are not slowed down', async () => {
    const t = make()
    await t.begin()
    t.w.frontReads = 0
    t.w.calls.length = 0
    const before = Date.now()
    await t.input({ type: 'text', text: 'hello' }, { type: 'move', x: 0.2, y: 0.2 })
    expect(Date.now() - before).toBeLessThan(150)
    expect(t.w.calls).toHaveLength(2)
  })
})

describe("finding 3: a click on one of Superagent's own native dialogs", () => {
  it('is refused when the window under the point reads as Superagent, even with Notes in front and no BrowserWindow there', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    t.w.front = NOTES
    t.w.ownSurface = false
    t.w.under = SELF
    for (const a of [
      { type: 'click', x: 0.5, y: 0.5 },
      { type: 'down', x: 0.5, y: 0.5 },
      { type: 'drag', x: 0.1, y: 0.1, toX: 0.5, toY: 0.5 }
    ] as RemoteInputAction[])
      expect((await t.refused(t.input(a))).reason).toBe('own-window')
    expect(t.w.calls).toEqual([])
  })
})

describe('finding 4: strikes and asks are per phone', () => {
  const OTHER = { connId: 'c2', deviceId: 'd2', deviceName: 'Other iPhone' }

  it('three turned-down requests from one phone do not lock another out', async () => {
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
    expect(t.c.request(OTHER).state).toBe('asking')
  })

  it('a phone that hangs up on each question is stopped after six an hour, and no dialog is shown for the seventh', async () => {
    const t = make()
    t.c.setEnabled(true)
    for (let i = 0; i < 6; i++) {
      await t.flush(6000)
      t.c.request(WHO)
      await t.flush()
      t.c.connGone('c1')
      await t.flush()
    }
    expect(t.w.askQs).toHaveLength(6)
    await t.flush(6000)
    expect(() => t.c.request(WHO)).toThrowError(/asked too often/)
    await t.flush(10_000)
    expect(t.w.askQs).toHaveLength(6)
    // Another phone is not held back by it, and the hour passes.
    expect(t.c.request(OTHER).state).toBe('asking')
    t.c.connGone('c2')
    await t.flush(61 * 60_000)
    expect(t.c.request(WHO).state).toBe('asking')
  })
})

describe("finding 5: the helper's words never reach the phone or the log", () => {
  it('a failed run says one fixed thing, whatever the helper said', async () => {
    const t = make()
    await t.begin()
    t.w.runFails = true
    t.w.runError =
      'Command failed: /Applications/Superagent.app/Contents/Resources/helper type hunter2'
    const e = await t.refused(t.input({ type: 'text', text: 'hunter2' }))
    expect(e.reason).toBe('failed')
    expect(e.message).toBe('The Mac did not do that.')
    expect(JSON.stringify(t.w.logs)).not.toMatch(/hunter2|Command failed/)
  })
})

describe('finding 6: a session belongs to a connection and the device behind it', () => {
  const IMPOSTOR = { connId: 'c1', deviceId: 'someone-else' }
  it('the same connection id with another device id gets nothing', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    await t.refused(t.c.input(IMPOSTOR, [{ type: 'click', x: 0.5, y: 0.5 }]))
    expect(() => t.c.view(IMPOSTOR, { visible: false })).toThrow()
    t.c.endFromPhone(IMPOSTOR)
    expect(t.c.wire('c1').state).toBe('active')
    expect(t.w.calls).toEqual([])
  })

  it('and cannot type the code of a request that is not its own', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: true, displayId: DISPLAY.id })
    await t.flush()
    expect(() => t.c.code(IMPOSTOR, '424242')).toThrowError(/nothing to confirm/)
    expect(t.c.wire('c1').state).toBe('code')
    t.c.code(CALLER, '424242')
    expect(t.c.wire('c1').state).toBe('active')
  })
})

describe('finding 7: the name in the dialog', () => {
  it('has bidi, zero-width and other invisible characters stripped before it is shown', async () => {
    const t = make()
    t.c.setEnabled(true)
    t.c.request({ ...WHO, deviceName: 'iPhone‮Evil​⁦x\u0085y z  ok' })
    await t.flush()
    expect(t.w.askQs[0].deviceName).toBe('iPhone Evil x y z ok')
  })
})

describe('finding 8: the cost of an action is what it makes the Mac do', () => {
  it('a 500-character text costs its pieces, and the next one right behind it waits', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    const text = 'a'.repeat(500)
    await t.input({ type: 'text', text })
    expect(t.w.calls).toHaveLength(21)
    expect((await t.refused(t.input({ type: 'text', text }))).reason).toBe('rate-limited')
    await t.flush(3000)
    await t.input({ type: 'text', text })
    expect(t.w.calls).toHaveLength(42)
  })

  it('looks at the Mac once per piece and no more, and the helper once per piece', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false }) // the stream's own looks are not what is measured
    t.w.calls.length = 0
    t.w.frontReads = 0
    await t.input({ type: 'text', text: 'a'.repeat(100) })
    expect(t.w.calls).toHaveLength(5)
    expect(t.w.frontReads).toBe(5)
  })

  it('caps typed characters a second: a stream of short texts is cut off at about 500 characters', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    const sent = Array.from({ length: 30 }, () =>
      t.c.input(CALLER, [{ type: 'text', text: 'b'.repeat(24) }]).then(
        () => 'done',
        (e: RemoteRefusal) => e.reason
      )
    )
    const results = await t.running(Promise.all(sent))
    const done = results.filter((r) => r === 'done').length
    expect(done).toBeGreaterThanOrEqual(18)
    expect(done).toBeLessThanOrEqual(22)
    expect(results.filter((r) => r === 'rate-limited').length).toBe(30 - done)
  })

  it('charges a long text by its pieces: what is left after one is what a few more looks cost, not what one action does', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    await t.input({ type: 'text', text: 'a'.repeat(500) })
    t.w.calls.length = 0
    const sent = Array.from({ length: 10 }, () =>
      t.c.input(CALLER, [{ type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 }]).then(
        () => 'done',
        (e: RemoteRefusal) => e.reason
      )
    )
    const results = await t.running(Promise.all(sent))
    expect(results.filter((r) => r === 'rate-limited').length).toBeGreaterThanOrEqual(3)
  })
})

// --- the second review's findings -------------------------------------------------

const NOTIF: AppRef = { id: 'com.apple.notificationcenterui', name: 'NotificationCenter' }
const DOCK: AppRef = { id: 'com.apple.dock', name: 'Dock' }
const SPOT: LaidWindow = win(SPOTLIGHT, 300, 100, 400, 80, 3)

describe('review 2, finding 2: input never depends on the stream having looked', () => {
  it('with the stream hidden, a password manager on the display (not in front, not under the pointer) stops keys', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.windows = [win(NOTES), win(ONEPW, 600, 100, 300, 300)]
    t.w.calls.length = 0
    const e = await t.refused(t.input({ type: 'key', key: 'a' }))
    expect(e.reason).toBe('paused')
    expect((await t.refused(t.input({ type: 'text', text: 'abc' }))).reason).toBe('paused')
    expect(t.w.calls).toEqual([])
  })

  it('and with it visible, a secret that arrived a moment ago stops them before the stream has looked', async () => {
    const t = make()
    await t.begin()
    await t.flush(2000)
    t.w.calls.length = 0
    t.w.windows = [win(NOTES), win(ONEPW, 600, 100, 300, 300)]
    expect((await t.refused(t.input({ type: 'key', key: 'a' }))).reason).toBe('paused')
    expect(t.w.calls).toEqual([])
  })

  it('and goes on once it has gone, without anyone asking for pictures', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.windows = [win(NOTES), win(ONEPW, 600, 100, 300, 300)]
    await t.refused(t.input({ type: 'key', key: 'a' }))
    t.w.windows = [win(NOTES)]
    await t.input({ type: 'key', key: 'a' })
    expect(t.w.calls.at(-1)).toEqual(['key', 'a'])
  })
})

describe("review 2, finding 4: a password manager's copy is not pasted", () => {
  it('refuses every paste while the clipboard is marked, and nothing else', async () => {
    const t = make()
    await t.begin()
    t.w.clipboardSecret = true
    t.w.calls.length = 0
    for (const mods of [
      ['cmd'],
      ['cmd', 'shift'],
      ['cmd', 'opt', 'shift'],
      ['cmd', 'ctrl']
    ] as const)
      expect((await t.refused(t.input({ type: 'key', key: 'v', mods: [...mods] }))).reason).toBe(
        'clipboard'
      )
    expect(t.w.calls).toEqual([])
    await t.input({ type: 'key', key: 'c', mods: ['cmd'] }, { type: 'key', key: 'v' })
    expect(t.w.calls).toEqual([
      ['key', 'cmd+c'],
      ['key', 'v']
    ])
    t.w.clipboardSecret = false
    await t.input({ type: 'key', key: 'v', mods: ['cmd'] })
    expect(t.w.calls.at(-1)).toEqual(['key', 'cmd+v'])
  })
})

describe('review 2, finding 5: not knowing what is under a point is a refusal', () => {
  it('a failed or timed-out look refuses; the desktop (nobody there) does not', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    t.w.appAtFails = true
    for (const a of [
      { type: 'click', x: 0.5, y: 0.5 },
      { type: 'drag', x: 0.1, y: 0.1, toX: 0.5, toY: 0.5 },
      { type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 }
    ] as RemoteInputAction[])
      expect((await t.refused(t.input(a))).reason).toBe('unknown')
    expect(t.w.calls).toEqual([])
    t.w.appAtFails = false
    t.w.under = null
    await t.input({ type: 'click', x: 0.5, y: 0.5 })
    expect(t.w.calls).toHaveLength(1)
  })
})

describe("review 2, finding 6: Superagent's native dialogs take no keys, and the banner no clicks", () => {
  it('any window of its own on layer 8 or up refuses everything, whatever lsappinfo says is in front', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    t.w.front = NOTES
    t.w.windows = [win(SELF, 400, 200, 300, 150, 8), win(NOTES)]
    for (const a of [
      { type: 'key', key: 'return' },
      { type: 'key', key: 'space' },
      { type: 'text', text: 'y' },
      { type: 'click', x: 0.1, y: 0.1 }
    ] as RemoteInputAction[])
      expect((await t.refused(t.input(a))).reason).toBe('own-window')
    expect(t.w.calls).toEqual([])
    // Gone: it goes on. (The banner, on layer 1000, is not one.)
    t.w.windows = [win(SELF, 300, 0, 440, 40, 1000), win(NOTES)]
    await t.input({ type: 'key', key: 'return' })
    expect(t.w.calls).toEqual([['key', 'return']])
  })

  it('a point inside the banner is refused for every kind of pointer action', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    t.w.ownSurface = true
    for (const a of [
      { type: 'move', x: 0.5, y: 0.05 },
      { type: 'click', x: 0.5, y: 0.05 },
      { type: 'down', x: 0.5, y: 0.05 },
      { type: 'up', x: 0.5, y: 0.05 },
      { type: 'drag', x: 0.5, y: 0.05, toX: 0.1, toY: 0.5 },
      { type: 'drag', x: 0.1, y: 0.5, toX: 0.5, toY: 0.05 },
      { type: 'scroll', x: 0.5, y: 0.05, dx: 0, dy: 0.1 }
    ] as RemoteInputAction[])
      expect((await t.refused(t.input(a))).reason).toBe('own-window')
    expect(t.w.calls).toEqual([])
  })
})

describe('review 2, finding 7: what a click launches is waited for', () => {
  it('a click while Spotlight is up (though not reported in front) waits long, so Terminal is seen', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.windows = [SPOT, win(NOTES)]
    t.w.calls.length = 0
    const p = t.input(
      { type: 'click', x: 0.5, y: 0.2 },
      { type: 'text', text: 'security dump-keychain' }
    )
    t.w.frontLater = { at: Date.now() + 800, app: TERMINAL }
    expect((await t.refused(p)).reason).toBe('shell')
    expect(t.w.calls).toHaveLength(1)
  })

  it('and so does Return, and a click on a Dock icon', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.windows = [SPOT, win(NOTES)]
    t.w.calls.length = 0
    const p = t.input({ type: 'key', key: 'return' }, { type: 'text', text: 'x' })
    t.w.frontLater = { at: Date.now() + 800, app: TERMINAL }
    expect((await t.refused(p)).reason).toBe('shell')

    const u = make()
    await u.begin()
    u.c.view(CALLER, { visible: false })
    u.w.windows = [win(DOCK, 200, 450, 600, 50, 20), win(NOTES)]
    const q = u.input({ type: 'click', x: 0.5, y: 0.95 }, { type: 'text', text: 'x' })
    u.w.frontLater = { at: Date.now() + 800, app: TERMINAL }
    expect((await u.refused(q)).reason).toBe('shell')
  })
})

describe('review 2, finding 8: the Apple menu and the Dock menu', () => {
  it("refuses a press on the Apple menu, and on the Dock's menu; a plain click on a Dock icon is fine", async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.windows = [win(DOCK, 200, 450, 600, 50, 20), win(NOTES)]
    t.w.calls.length = 0
    expect((await t.refused(t.input({ type: 'click', x: 0.01, y: 0.01 }))).reason).toBe(
      'system-menu'
    )
    expect(
      (await t.refused(t.input({ type: 'click', x: 0.5, y: 0.95, button: 'right' }))).reason
    ).toBe('dock-menu')
    expect((await t.refused(t.input({ type: 'down', x: 0.5, y: 0.95 }))).reason).toBe('dock-menu')
    expect(t.w.calls).toEqual([])
    // Moving there, and a left click on an icon, are not.
    await t.input({ type: 'move', x: 0.01, y: 0.01 }, { type: 'click', x: 0.5, y: 0.95 })
    expect(t.w.calls.map((c) => c[0])).toEqual(['jump', 'tap'])
  })
})

describe('review 2, finding 12: ending, and the picture', () => {
  it('after cutting a run short, lets go of both buttons where the pointer is', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    t.w.killRuns = 1
    t.c.end('hotkey')
    await t.flush()
    expect(t.w.calls).toEqual([
      ['up', '100', '50', 'left'],
      ['up', '100', '50', 'right']
    ])
  })

  it('and posts nothing when nothing was cut short and nothing held', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    t.c.end('hotkey')
    await t.flush()
    expect(t.w.calls).toEqual([])
  })

  it('covers notification banners in the picture (codes, message previews)', async () => {
    const t = make()
    await t.begin()
    t.w.windows = [win(NOTES, 0, 0, 500, 500), win(NOTIF, 500, 0, 500, 500, 25)]
    await t.flush(2000)
    expect(t.c.wire('c1').paused).toBeNull()
    const pic = t.w.pictures.at(-1)!
    const at = (x: number, y: number): number => pic.data[(y * pic.width + x) * 4]
    expect(at(50, 50)).toBe(255)
    expect(at(150, 50)).toBe(0x2b)
  })
})

// --- the third review's findings ----------------------------------------------------

describe('review 3, S1: a copied password is not pasted from a menu either', () => {
  it('while the pasteboard is marked, right-clicks and presses in the menu bar are refused, whatever the key', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.clipboardSecret = true
    t.w.calls.length = 0
    for (const a of [
      { type: 'click', x: 0.5, y: 0.5, button: 'right' },
      { type: 'down', x: 0.5, y: 0.5, button: 'right' },
      { type: 'click', x: 0.5, y: 0.02 }, // Edit menu, in the menu bar
      { type: 'down', x: 0.5, y: 0.02 },
      { type: 'drag', x: 0.5, y: 0.5, toX: 0.5, toY: 0.02 }
    ] as RemoteInputAction[])
      expect((await t.refused(t.input(a))).reason).toBe('clipboard')
    expect((await t.refused(t.input({ type: 'key', key: 'v', mods: ['cmd'] }))).reason).toBe(
      'clipboard'
    )
    expect(t.w.calls).toEqual([])
    // Moving there, scrolling, and an ordinary click are not paste.
    await t.input(
      { type: 'move', x: 0.5, y: 0.02 },
      { type: 'click', x: 0.5, y: 0.5 },
      { type: 'scroll', x: 0.5, y: 0.5, dx: 0, dy: 0.1 }
    )
    expect(t.w.calls.map((c) => c[0])).toEqual(['jump', 'tap', 'wheel'])
  })

  it('and when it is not marked, they are fine', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.calls.length = 0
    await t.input(
      { type: 'click', x: 0.5, y: 0.5, button: 'right' },
      { type: 'click', x: 0.5, y: 0.02 }
    )
    expect(t.w.calls.map((c) => c[0])).toEqual(['tap', 'tap'])
  })
})

describe('review 3, S2: the menu bar and the Dock are not reached by keys either', () => {
  it('Control with F2 and F3, with or without fn, and the Help search, are never pressed', async () => {
    const t = make()
    await t.begin()
    t.w.calls.length = 0
    for (const [key, mods] of [
      ['f2', ['ctrl']],
      ['f2', ['ctrl', 'fn']],
      ['f3', ['ctrl']],
      ['f8', ['ctrl', 'fn']],
      ['/', ['cmd', 'shift']],
      ['a', ['ctrl', 'opt', 'cmd']]
    ] as const)
      expect(
        (await t.refused(t.input({ type: 'key', key, mods: [...mods] }))).reason,
        `${mods.join('+')}+${key}`
      ).toBe('blocked-key')
    expect(t.w.calls).toEqual([])
  })
})

describe('review 3, S3: prompts from outside any app, and windows far above the rest', () => {
  const COREAUTHA: AppRef = { id: 'name:coreautha', name: 'coreautha' }
  const SHIELD: AppRef = { id: 'com.vendor.shield', name: 'Shield' }

  it('a system prompt known only by its process name pauses input and the stream', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.windows = [win(NOTES), win(COREAUTHA, 300, 100, 400, 200, 8)]
    t.w.calls.length = 0
    expect((await t.refused(t.input({ type: 'key', key: 'a' }))).reason).toBe('paused')
    expect((await t.refused(t.input({ type: 'text', text: 'a' }))).reason).toBe('paused')
    expect(t.w.calls).toEqual([])
    const u = make()
    await u.begin()
    u.w.windows = [win(NOTES), win(COREAUTHA, 300, 100, 400, 200, 8)]
    u.w.frames.length = 0
    await u.flush(2000)
    expect(u.c.wire('c1')).toMatchObject({ paused: 'secret' })
    expect(u.w.frames.filter((f) => f.t === 'screen' && f.frame.jpeg !== '')).toHaveLength(0)
  })

  it('any unknown window at the screen-saver level or above pauses, popup menus and drags do not, notifications are covered', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.calls.length = 0
    t.w.windows = [win(SHIELD, 0, 0, 1000, 500, 1000), win(NOTES)]
    expect((await t.refused(t.input({ type: 'key', key: 'a' }))).reason).toBe('paused')
    t.w.windows = [win(SHIELD, 0, 0, 1000, 500, 2000000), win(NOTES)]
    expect((await t.refused(t.input({ type: 'key', key: 'a' }))).reason).toBe('paused')
    // Popup menu (101), help tag (200), drag in progress (500): ordinary.
    for (const layer of [101, 200, 500]) {
      t.w.windows = [win(SHIELD, 100, 100, 100, 100, layer), win(NOTES)]
      await t.input({ type: 'key', key: 'a' })
    }
    // Notification banners, high up as they are, are covered rather than pausing.
    t.w.windows = [win(NOTIF, 0, 0, 300, 60, 1000), win(NOTES)]
    await t.input({ type: 'key', key: 'b' })
    // Superagent's own banner (layer 1000) is not a reason either.
    t.w.windows = [win(SELF, 300, 0, 440, 40, 1000), win(NOTES)]
    await t.input({ type: 'key', key: 'c' })
    expect(t.w.calls.map((c) => c[1])).toEqual(['a', 'a', 'a', 'b', 'c'])
  })
})

describe('review 3, M3: all phones together get only so many dialogs an hour', () => {
  it('twelve in an hour across several pairings, then none, until the hour passes', async () => {
    const t = make()
    t.c.setEnabled(true)
    const phones = ['d1', 'd2', 'd3'].map((id, i) => ({
      connId: `c${i + 1}`,
      deviceId: id,
      deviceName: `iPhone ${i}`
    }))
    let shown = 0
    for (let round = 0; round < 5; round++)
      for (const who of phones) {
        await t.flush(6000)
        try {
          t.c.request(who)
        } catch {
          continue
        }
        await t.flush()
        shown++
        t.c.connGone(who.connId)
        await t.flush()
      }
    expect(shown).toBe(12)
    expect(t.w.askQs).toHaveLength(12)
    await t.flush(6000)
    expect(() => t.c.request(phones[0])).toThrowError(/asked too often|too often/)
    await t.flush(61 * 60_000)
    expect(t.c.request(phones[0]).state).toBe('asking')
  })

  it('a phone cannot keep asking each time its request expires: expiries are strikes', async () => {
    const t = make()
    t.c.setEnabled(true)
    for (let i = 0; i < 3; i++) {
      t.c.request(WHO)
      await t.flush(REMOTE_ASK_MS + 1)
      expect(t.c.wire('c1')).toMatchObject({ ended: 'expired' })
    }
    expect(() => t.c.request(WHO)).toThrowError(/Too many requests were turned down/)
    expect(t.w.askQs).toHaveLength(3)
  })
})

describe('review 4', () => {
  it('the menu bar band is 50 points, or the menu bar itself when that is deeper (More Space)', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.clipboardSecret = true
    t.w.calls.length = 0
    // y = 0.098 * 500 = 49: inside 50, below an old 40.
    expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.098 }))).reason).toBe('clipboard')
    await t.input({ type: 'click', x: 0.5, y: 0.12 })
    expect(t.w.calls).toHaveLength(1)
    // A display whose menu bar is 70 deep, read again on the next action.
    t.w.displays = [{ ...DISPLAY, menuBar: 70 }]
    expect((await t.refused(t.input({ type: 'click', x: 0.5, y: 0.12 }))).reason).toBe('clipboard')
    await t.input({ type: 'click', x: 0.5, y: 0.15 })
    expect(t.w.calls).toHaveLength(2)
  })

  it('Control-V and Control-Shift-V are not pasted from a marked clipboard either', async () => {
    const t = make()
    await t.begin()
    t.w.clipboardSecret = true
    t.w.calls.length = 0
    for (const mods of [['ctrl'], ['ctrl', 'shift']] as const)
      expect((await t.refused(t.input({ type: 'key', key: 'v', mods: [...mods] }))).reason).toBe(
        'clipboard'
      )
    expect(t.w.calls).toEqual([])
  })

  it('a banner that is not showing ends the session, on an action and on the stream, after a moment of grace', async () => {
    const t = make()
    await t.begin()
    t.c.view(CALLER, { visible: false })
    t.w.bannerHiddenNow = true
    // Just shown: not yet listed is not yet a reason.
    await t.input({ type: 'key', key: 'a' })
    expect(t.c.wire('c1').state).toBe('active')
    await t.flush(600)
    const e = await t.refused(t.input({ type: 'key', key: 'b' }))
    expect(e.reason).toBe('ended')
    expect(t.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'banner-lost' })
    const u = make()
    await u.begin()
    u.w.bannerHiddenNow = true
    await u.flush(2000)
    expect(u.c.wire('c1')).toMatchObject({ state: 'idle', ended: 'banner-lost' })
  })

  it('ends only the session it looked at, not one that started since', async () => {
    const t = make()
    await t.begin()
    await t.flush(600)
    // The check reads the windows, the session ends meanwhile and a new one starts:
    // the old reading must not end the new session.
    let release: (() => void) | null = null
    const layout = t.deps.layout
    t.deps.layout = () =>
      new Promise((r) => {
        release = () => r(layout())
      }) as never
    t.w.bannerHiddenNow = true
    const p = t.c.input(CALLER, [{ type: 'key', key: 'a' }]).catch((x: unknown) => x)
    await t.flush()
    t.deps.layout = layout
    t.c.end('hotkey')
    t.w.bannerHiddenNow = false
    await t.flush(6000)
    t.c.request(WHO)
    await t.flush()
    t.w.asks.shift()!({ allow: true, displayId: DISPLAY.id })
    await t.flush()
    t.c.code(CALLER, t.w.codes.at(-1)!)
    expect(t.c.wire('c1').state).toBe('active')
    // Only the old reading looks at the banner from here on, and well past the new one's grace.
    t.c.view(CALLER, { visible: false })
    await t.flush(600)
    t.w.bannerHiddenNow = true
    release!()
    await t.flush()
    await p
    expect(t.c.wire('c1').state).toBe('active')
  })
})
