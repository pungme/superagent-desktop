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

const { simTarget, noteSimulatorOpen, noteSimulatorClosed, noteSimulatorClosedForChat, chatHoldingSimulator } =
  await import('./simulator')

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
