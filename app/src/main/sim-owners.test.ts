import { describe, expect, it } from 'vitest'
import { SimOwners, OWNER_IDLE_MS } from './sim-owners'
import {
  chooseSimulator,
  simOwners,
  chatHoldingSimulator,
  simTarget,
  type SimDevice
} from './simulator'

const PHONE = '518AC69A-303D-4357-9FE7-7FEAA4E4E84B'
const memory = (): { load: () => string | undefined; save: (j: string) => string } => {
  let saved: string | undefined
  return { load: () => saved, save: (j: string) => (saved = j) }
}

describe('who owns a simulator', () => {
  /** 2026-10-22: a restart forgot the owner and the device went to the next conversation. */
  it('survives a restart', () => {
    const store = memory()
    const before = new SimOwners()
    before.attach(store, () => true)
    expect(before.claim('shotcaller', PHONE)).toBe(true)
    const after = new SimOwners()
    after.attach(store, () => true)
    expect(after.ownerOf(PHONE)).toBe('shotcaller')
    expect(after.claim('wepush-ios', PHONE)).toBe(false)
  })

  it('keeps the first claim, and lets the owner keep using it', () => {
    const o = new SimOwners()
    expect(o.claim('a', PHONE, 1000)).toBe(true)
    expect(o.claim('b', PHONE, 2000)).toBe(false)
    expect(o.claim('a', PHONE, 3000)).toBe(true)
    expect(o.ownerOf(PHONE, 3000)).toBe('a')
    expect(o.sinceOf(PHONE, 3000)).toBe(1000)
  })

  it('frees a device after a day unused, or when its conversation is gone', () => {
    const o = new SimOwners()
    o.claim('a', PHONE, 0)
    expect(o.ownerOf(PHONE, OWNER_IDLE_MS + 1)).toBeNull()
    const store = memory()
    const s = new SimOwners()
    s.attach(store, () => true)
    s.claim('deleted-chat', PHONE)
    const again = new SimOwners()
    again.attach(store, (id) => id !== 'deleted-chat')
    expect(again.ownerOf(PHONE)).toBeNull()
  })

  it('forgets devices that no longer exist, case-insensitively', () => {
    const o = new SimOwners()
    o.claim('a', PHONE.toLowerCase())
    o.keepOnly(['OTHER'])
    expect(o.ownerOf(PHONE)).toBeNull()
  })
})

describe('handing out simulators with owners', () => {
  const dev = (udid: string, name = 'iPhone 18 Pro'): SimDevice => ({
    udid,
    name,
    state: 'Booted',
    runtime: 'iOS-27-0',
    deviceTypeIdentifier: 'iPhone-18-Pro'
  })

  /** The incident: the device a conversation drives from its scripts went to another. */
  it('does not give a conversation a device another one owns, even with no pane open', () => {
    simOwners.claim('shotcaller', PHONE)
    const choice = chooseSimulator('wepush-ios', [dev(PHONE)])
    expect(choice && 'use' in choice ? choice.use.udid : null).not.toBe(PHONE)
    expect(choice && 'create' in choice).toBe(true)
    expect(chatHoldingSimulator(PHONE, 'wepush-ios')).toBe('shotcaller')
    // And the owner is still aimed at its own.
    expect(simTarget('shotcaller')).toBe(PHONE)
    simOwners.forgetChat('shotcaller')
  })

  it('a free twin goes to the second conversation', () => {
    const TWIN = 'D7700CA8-E8C9-4D40-B698-860F8D851AAB'
    simOwners.claim('shotcaller', PHONE)
    const choice = chooseSimulator('wepush-ios', [dev(PHONE), dev(TWIN, 'iPhone 18 Pro (2)')])
    expect(choice && 'use' in choice ? choice.use.udid : null).toBe(TWIN)
    simOwners.forgetChat('shotcaller')
  })
})
