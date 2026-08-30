import { describe, it, expect, afterEach, vi } from 'vitest'
import { startPairing, cancelPairing, pendingPairing, PAIRING_TTL_MS } from './pairing'

vi.mock('./identity', () => ({
  machineId: () => 'cd'.repeat(32),
  prettyHostname: () => 'Test Mac'
}))

const relay = 'wss://relay.invalid'

afterEach(() => {
  cancelPairing()
  vi.useRealTimers()
})

describe('pairing lifecycle', () => {
  // The bug this guards: showing the code again rotated the secret, so a link
  // copied a moment earlier no longer matched the code on screen, and the
  // phone that opened it was dropped by a Mac that no longer held its key.
  it('returns the same code and link while a pairing is still live', () => {
    const first = startPairing(relay)
    const second = startPairing(relay)
    expect(second.code).toBe(first.code)
    expect(second.payload.k).toBe(first.payload.k)
    expect(second.expiresAt).toBe(first.expiresAt)
  })

  it('issues a new one after an explicit cancel', () => {
    const first = startPairing(relay)
    cancelPairing()
    const second = startPairing(relay)
    expect(second.payload.k).not.toBe(first.payload.k)
  })

  it('issues a new one once the old has expired', () => {
    vi.useFakeTimers()
    const first = startPairing(relay)
    vi.advanceTimersByTime(PAIRING_TTL_MS + 1000)
    expect(pendingPairing()).toBeNull()
    const second = startPairing(relay)
    expect(second.payload.k).not.toBe(first.payload.k)
  })
})
