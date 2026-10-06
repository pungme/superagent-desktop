import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Which simulator a conversation drives.
 *
 * The target used to be global — one booted device was everyone's, two booted
 * devices was an error for everyone — so a second conversation could not use a
 * second simulator, and two sharing one installed over each other unaware. The
 * per-chat map existed for phone mirroring; simTarget just never read it.
 */
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sa-sim-test', on: () => undefined },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
  systemPreferences: {},
  shell: {}
}))
vi.mock('./browser', () => ({ agentIsDriving: () => false }))

const {
  simTarget,
  noteSimulatorOpen,
  noteSimulatorClosed,
  noteSimulatorClosedForChat,
  chatHoldingSimulator,
  chooseSimulator,
  chatAheadOnSimulator,
  allowSharedSimulator
} = await import('./simulator')

const A = 'chat-a'
const B = 'chat-b'
const IPHONE = 'UDID-IPHONE-17'
const IPAD = 'UDID-IPAD-PRO'

describe('the simulator a conversation drives', () => {
  beforeEach(() => {
    noteSimulatorClosed(IPHONE)
    noteSimulatorClosed(IPAD)
  })

  /** Nothing chosen: fall back to whatever simctl would pick. */
  it('has no opinion before a conversation opens one', () => {
    expect(simTarget(A)).toBe('booted')
    expect(simTarget(null)).toBe('booted')
  })

  it('drives the device that conversation opened', () => {
    noteSimulatorOpen(A, IPHONE)
    expect(simTarget(A)).toBe(IPHONE)
  })

  /** The window's ✕ closes one chat's pane, not every chat showing that device. */
  it("closing one chat's pane leaves another chat's claim on the same device", () => {
    noteSimulatorOpen(A, IPHONE)
    noteSimulatorOpen(B, IPHONE)
    noteSimulatorClosedForChat(A)
    expect(simTarget(A)).toBe('booted')
    expect(simTarget(B)).toBe(IPHONE)
  })

  /** The whole point: two conversations, two devices, at the same time. */
  it('gives two conversations two different devices', () => {
    noteSimulatorOpen(A, IPHONE)
    noteSimulatorOpen(B, IPAD)
    expect(simTarget(A)).toBe(IPHONE)
    expect(simTarget(B)).toBe(IPAD)
  })

  /** Before the fix this was the failure: A's choice became B's target. */
  it('does not hand one conversation the other conversation device', () => {
    noteSimulatorOpen(A, IPHONE)
    expect(simTarget(B)).not.toBe(IPHONE)
    expect(simTarget(B)).toBe('booted')
  })

  it('follows a conversation that switches device', () => {
    noteSimulatorOpen(A, IPHONE)
    noteSimulatorOpen(A, IPAD)
    expect(simTarget(A)).toBe(IPAD)
  })

  it('lets go when the device closes', () => {
    noteSimulatorOpen(A, IPHONE)
    noteSimulatorClosed(IPHONE)
    expect(simTarget(A)).toBe('booted')
  })
})

describe('knowing who else is on a device', () => {
  beforeEach(() => {
    noteSimulatorClosed(IPHONE)
    noteSimulatorClosed(IPAD)
  })

  it('names the other conversation holding it', () => {
    noteSimulatorOpen(A, IPHONE)
    expect(chatHoldingSimulator(IPHONE, B)).toBe(A)
  })

  /** Asking about your own device must not report you as a stranger on it. */
  it('does not report you as a conflict with yourself', () => {
    noteSimulatorOpen(A, IPHONE)
    expect(chatHoldingSimulator(IPHONE, A)).toBeNull()
  })

  it('is silent about a device nobody has', () => {
    expect(chatHoldingSimulator(IPAD, A)).toBeNull()
  })
})

describe('giving each conversation a simulator of its own', () => {
  const RT = 'com.apple.CoreSimulator.SimRuntime.iOS-26-0'
  const E17 = 'com.apple.CoreSimulator.SimDeviceType.iPhone-17e'
  const dev = (udid: string, name: string, state: string, type = E17) => ({
    udid,
    name,
    state,
    runtime: RT,
    deviceTypeIdentifier: type
  })
  const TWIN = 'UDID-IPHONE-17-B'
  const C = 'chat-c'
  beforeEach(() => {
    for (const u of [IPHONE, IPAD, TWIN]) noteSimulatorClosed(u)
  })

  it('takes the booted device when nobody has it', () => {
    const got = chooseSimulator(A, [dev(IPHONE, 'iPhone 17e', 'Booted')])
    expect(got).toEqual({ use: expect.objectContaining({ udid: IPHONE }) })
  })

  it('keeps the device it already has', () => {
    noteSimulatorOpen(A, IPHONE)
    noteSimulatorOpen(B, TWIN)
    const all = [dev(IPHONE, 'iPhone 17e', 'Booted'), dev(TWIN, 'iPhone 17e (2)', 'Booted')]
    expect(chooseSimulator(A, all)).toEqual({ use: expect.objectContaining({ udid: IPHONE }) })
    expect(chooseSimulator(B, all)).toEqual({ use: expect.objectContaining({ udid: TWIN }) })
  })

  /** The bug: the second conversation adopted the one booted device. */
  it('does not hand a second conversation the device the first is on', () => {
    noteSimulatorOpen(A, IPHONE)
    const got = chooseSimulator(B, [
      dev(IPHONE, 'iPhone 17e', 'Booted'),
      dev(TWIN, 'iPhone 17e', 'Shutdown'),
      dev(IPAD, 'iPad Pro', 'Shutdown', 'ipad')
    ])
    // Another device of the same model, not the iPad and not the taken one.
    expect(got).toEqual({
      use: expect.objectContaining({ udid: TWIN }),
      insteadOf: expect.objectContaining({ udid: IPHONE })
    })
  })

  it('asks for a new device of the same model when there is no spare one', () => {
    noteSimulatorOpen(A, IPHONE)
    const got = chooseSimulator(B, [dev(IPHONE, 'iPhone 17e', 'Booted')])
    expect(got).toEqual({
      create: { name: 'iPhone 17e (2)', deviceType: E17, runtime: RT },
      insteadOf: expect.objectContaining({ udid: IPHONE })
    })
  })

  it('gives a third conversation a third device', () => {
    noteSimulatorOpen(A, IPHONE)
    noteSimulatorOpen(B, TWIN)
    const got = chooseSimulator(C, [
      dev(IPHONE, 'iPhone 17e', 'Booted'),
      dev(TWIN, 'iPhone 17e (2)', 'Booted')
    ])
    expect(got).toMatchObject({ create: { name: 'iPhone 17e (3)' } })
  })

  /** A pane shows whatever is booted, which can put B on A's device. */
  it('moves a conversation off a device another one had first', () => {
    noteSimulatorOpen(A, IPHONE)
    noteSimulatorOpen(B, IPHONE)
    expect(chatAheadOnSimulator(IPHONE, A)).toBeNull()
    expect(chatAheadOnSimulator(IPHONE, B)).toBe(A)
    const all = [dev(IPHONE, 'iPhone 17e', 'Booted'), dev(TWIN, 'iPhone 17e', 'Shutdown')]
    expect(chooseSimulator(A, all)).toEqual({ use: expect.objectContaining({ udid: IPHONE }) })
    expect(chooseSimulator(B, all)).toMatchObject({ use: { udid: TWIN } })
  })

  it('asked for a taken device, gives its twin; asked for a free one, gives that', () => {
    noteSimulatorOpen(A, IPHONE)
    const all = [
      dev(IPHONE, 'iPhone 17e', 'Booted'),
      dev(TWIN, 'iPhone 17e', 'Shutdown'),
      dev(IPAD, 'iPad Pro', 'Shutdown', 'ipad')
    ]
    expect(chooseSimulator(B, all, { like: IPHONE })).toMatchObject({ use: { udid: TWIN } })
    expect(chooseSimulator(B, all, { like: IPAD })).toEqual({
      use: expect.objectContaining({ udid: IPAD })
    })
  })

  it('shares only when told to', () => {
    noteSimulatorOpen(A, IPHONE)
    noteSimulatorOpen(B, IPHONE)
    allowSharedSimulator(B)
    expect(chatAheadOnSimulator(IPHONE, B)).toBeNull()
    expect(chooseSimulator(B, [dev(IPHONE, 'iPhone 17e', 'Booted')])).toEqual({
      use: expect.objectContaining({ udid: IPHONE })
    })
  })

  /** An iPad is not a stand-in for an iPhone. */
  it('does not guess between several free booted devices', () => {
    const got = chooseSimulator(A, [
      dev(IPHONE, 'iPhone 17e', 'Booted'),
      dev(IPAD, 'iPad Pro', 'Booted', 'ipad')
    ])
    expect(got).toMatchObject({ ambiguous: [{ udid: IPHONE }, { udid: IPAD }] })
  })

  it('does not assume the free one is the model wanted when another is taken', () => {
    noteSimulatorOpen(A, IPHONE)
    const got = chooseSimulator(B, [
      dev(IPHONE, 'iPhone 17e', 'Booted'),
      dev(IPAD, 'iPad Pro', 'Booted', 'ipad')
    ])
    expect(got).toMatchObject({ ambiguous: [{ udid: IPAD }] })
  })

  it('has nothing to offer when nothing is booted', () => {
    expect(chooseSimulator(A, [dev(IPHONE, 'iPhone 17e', 'Shutdown')])).toBeNull()
  })
})
