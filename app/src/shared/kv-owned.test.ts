import { describe, it, expect } from 'vitest'
import { isMainOwnedKey } from './kv-owned'

describe("main's own settings are kept out of the window's mirror", () => {
  it('covers the dot, computer use, Mail, the phone and power', () => {
    for (const k of [
      'dot.enabled',
      'dot.hotkey',
      'computer.enabled',
      'computer.sealed',
      'connections.appleMail',
      'companion.keepAwakeAlways',
      'power.lidAwake',
      'cove.betaUpdates',
      'migrated.chat_data'
    ])
      expect(isMainOwnedKey(k), k).toBe(true)
  })
  it("leaves the window's own keys, and shared ones it writes, alone", () => {
    for (const k of [
      'dot.position',
      'cove.theme',
      'cove.model',
      'cove.onboarded',
      'simOpen:w1',
      'activeWorkspace'
    ])
      expect(isMainOwnedKey(k), k).toBe(false)
  })
})
