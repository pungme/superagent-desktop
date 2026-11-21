import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createSimViewController, type SimViewAttachInfo, type SimViewModule } from './sim-view'

interface FakeWindow {
  isDestroyed: () => boolean
  getNativeWindowHandle: () => Buffer
  webContents: {
    getZoomFactor: () => number
    send: (channel: string, payload?: unknown) => void
  }
  once: (event: string, cb: () => void) => void
  destroyNow: () => void
  sent: { channel: string; payload: unknown }[]
}

function makeWindow(): FakeWindow {
  let destroyed = false
  const sent: { channel: string; payload: unknown }[] = []
  const closedListeners: (() => void)[] = []
  return {
    isDestroyed: () => destroyed,
    getNativeWindowHandle: () => Buffer.alloc(8),
    webContents: {
      getZoomFactor: () => 1,
      send: (channel: string, payload?: unknown) => sent.push({ channel, payload })
    },
    once: (event: string, cb: () => void) => {
      if (event === 'closed') closedListeners.push(cb)
    },
    destroyNow: () => {
      destroyed = true
      for (const cb of closedListeners) cb()
    },
    sent
  }
}

const toPoints = (w: number, h: number): { width: number; height: number } => ({
  width: Math.round(w / 3),
  height: Math.round(h / 3)
})

describe('sim-view async attach & hang protection', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('attaches asynchronously without blocking and converts pixels to points', async () => {
    const detachSpy = vi.fn()
    const mod: SimViewModule = {
      attach: vi.fn(),
      attachAsync: vi.fn(async () => ({
        id: 1,
        width: 1206,
        height: 2622,
        screens: 1,
        device: 'iPhone 17'
      })),
      size: vi.fn(() => ({ width: 1206, height: 2622 })),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      detach: detachSpy,
      screens: vi.fn(() => []),
      health: vi.fn(() => ({ screens: 1, width: 1206, height: 2622 }))
    }
    const ctrl = createSimViewController({
      load: () => mod,
      toPoints,
      onGone: vi.fn(),
      log: vi.fn(),
      attachTimeoutMs: 2000
    })
    const win = makeWindow()
    const res = await ctrl.attach(win as never, 'UDID-1')
    expect(res).toEqual({ ok: true, width: 402, height: 874, screens: 1, device: 'iPhone 17' })
    expect(mod.attach).not.toHaveBeenCalled()
    expect(mod.attachAsync).toHaveBeenCalledTimes(1)
    expect(ctrl.isViewing('UDID-1')).toBe(true)

    ctrl.detach('UDID-1')
    expect(detachSpy).toHaveBeenCalledWith(1)
    expect(ctrl.isViewing('UDID-1')).toBe(false)
  })

  it('times out a wedged CoreSimulator attach, does not stack retries, isolates other devices, and recovers once unstuck', async () => {
    let resolveStuck!: (v: SimViewAttachInfo) => void
    let callCount = 0
    const detachSpy = vi.fn()
    const logs: string[] = []
    const mod: SimViewModule = {
      attach: vi.fn(),
      attachAsync: vi.fn(({ udid }: { view: Buffer; udid: string }): Promise<SimViewAttachInfo> => {
        if (udid === 'WEDGED') {
          callCount += 1
          if (callCount === 1) {
            return new Promise<SimViewAttachInfo>((r) => {
              resolveStuck = r
            })
          }
          return Promise.resolve({
            id: 3,
            width: 1206,
            height: 2622,
            screens: 1,
            device: 'iPhone Duo'
          })
        }
        return Promise.resolve({
          id: 2,
          width: 1179,
          height: 2556,
          screens: 1,
          device: 'Healthy iPhone'
        })
      }),
      size: vi.fn(() => ({})),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      detach: detachSpy,
      screens: vi.fn(() => []),
      health: vi.fn(() => ({ screens: 1, width: 1179, height: 2556 }))
    }

    const ctrl = createSimViewController({
      load: () => mod,
      toPoints,
      onGone: vi.fn(),
      log: (line) => logs.push(line),
      attachTimeoutMs: 2000
    })
    const win = makeWindow()

    // Start attach on the wedged simulator — times out cleanly after 2s.
    const p1 = ctrl.attach(win as never, 'WEDGED')
    await vi.advanceTimersByTimeAsync(2000)
    const r1 = await p1
    expect(r1).toEqual({ ok: false, error: 'simulator display service timed out' })
    expect(ctrl.isViewing('WEDGED')).toBe(false)

    // Retrying while still stuck returns immediately without spawning another native attach.
    const r2 = await ctrl.attach(win as never, 'WEDGED')
    expect(r2).toEqual({ ok: false, error: 'simulator display service timed out' })
    expect(callCount).toBe(1)

    // Meanwhile, a healthy simulator attaches independently and immediately.
    const rHealthy = await ctrl.attach(win as never, 'HEALTHY')
    expect(rHealthy).toEqual({
      ok: true,
      width: 393,
      height: 852,
      screens: 1,
      device: 'Healthy iPhone'
    })
    expect(ctrl.isViewing('HEALTHY')).toBe(true)

    // Later, the wedged simulator unblocks and returns a stale attachment:
    // it must be detached immediately (never leaked) and clear the in-flight guard.
    resolveStuck({ id: 99, width: 1206, height: 2622, screens: 1, device: 'iPhone Duo' })
    await Promise.resolve()
    await Promise.resolve()
    expect(detachSpy).toHaveBeenCalledWith(99)
    expect(ctrl.isViewing('WEDGED')).toBe(false)

    // Next retry now starts a fresh attach and succeeds!
    const r3 = await ctrl.attach(win as never, 'WEDGED')
    expect(r3).toEqual({ ok: true, width: 402, height: 874, screens: 1, device: 'iPhone Duo' })
    expect(callCount).toBe(2)

    ctrl.detachAll()
  })

  it('detaches a late attach result if detach() was called while attach was in flight', async () => {
    let resolveAttach!: (v: SimViewAttachInfo) => void
    const detachSpy = vi.fn()
    const mod: SimViewModule = {
      attach: vi.fn(),
      attachAsync: vi.fn(
        (): Promise<SimViewAttachInfo> =>
          new Promise<SimViewAttachInfo>((r) => {
            resolveAttach = r
          })
      ),
      size: vi.fn(() => ({})),
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      detach: detachSpy,
      screens: vi.fn(() => []),
      health: vi.fn(() => ({ screens: 1, width: 1206, height: 2622 }))
    }

    const ctrl = createSimViewController({
      load: () => mod,
      toPoints,
      onGone: vi.fn(),
      log: vi.fn(),
      attachTimeoutMs: 5000
    })
    const win = makeWindow()

    const p = ctrl.attach(win as never, 'UDID-SWITCH')
    // User switches chats before attach finishes.
    ctrl.detach('UDID-SWITCH')
    resolveAttach({ id: 7, width: 1206, height: 2622, screens: 1, device: 'iPhone' })
    const res = await p
    expect(res).toEqual({ ok: false, error: 'cancelled' })
    expect(detachSpy).toHaveBeenCalledWith(7)
    expect(ctrl.isViewing('UDID-SWITCH')).toBe(false)
  })

  it('uses health() for resize and gone detection without ever calling screens()', async () => {
    let healthState = { screens: 1, width: 1206, height: 2622 }
    const onGone = vi.fn()
    const screensSpy = vi.fn(() => [])
    const sizeSpy = vi.fn(() => ({}))
    const detachSpy = vi.fn()
    const mod: SimViewModule = {
      attach: vi.fn(),
      attachAsync: vi.fn(async () => ({
        id: 5,
        width: 1206,
        height: 2622,
        screens: 2,
        device: 'iPhone Duo'
      })),
      size: sizeSpy,
      setBounds: vi.fn(),
      setVisible: vi.fn(),
      detach: detachSpy,
      screens: screensSpy,
      health: vi.fn(() => healthState)
    }

    const ctrl = createSimViewController({
      load: () => mod,
      toPoints,
      onGone,
      log: vi.fn(),
      attachTimeoutMs: 2000
    })
    const win = makeWindow()
    await ctrl.attach(win as never, 'FOLD')

    // Screen changes size (foldable opened):
    healthState = { screens: 2, width: 2100, height: 2400 }
    await vi.advanceTimersByTimeAsync(1000)
    expect(win.sent).toContainEqual({
      channel: 'sim:view-size:FOLD',
      payload: { width: 700, height: 800 }
    })
    expect(screensSpy).not.toHaveBeenCalled()
    expect(sizeSpy).not.toHaveBeenCalled()

    // Device shuts down: two consecutive misses detach and emit sim:gone.
    healthState = { screens: 0, width: 0, height: 0 }
    await vi.advanceTimersByTimeAsync(2000)
    expect(detachSpy).toHaveBeenCalledWith(5)
    expect(onGone).toHaveBeenCalledWith('FOLD')
    expect(win.sent).toContainEqual({ channel: 'sim:gone:FOLD', payload: undefined })
  })
})
