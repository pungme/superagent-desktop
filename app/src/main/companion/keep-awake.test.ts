import { describe, it, expect } from 'vitest'
import { keepAwakeSetting, shouldStayAwake } from './keep-awake'

describe('the keep-awake setting', () => {
  it('is on for a Mac that has never been asked', () => {
    expect(keepAwakeSetting(undefined)).toBe(true)
  })

  it('is off only because someone turned it off', () => {
    expect(keepAwakeSetting('0')).toBe(false)
    expect(keepAwakeSetting('1')).toBe(true)
  })

  /** Off used to be written as an empty string. Those Macs stay off. */
  it('honours the old way of writing off', () => {
    expect(keepAwakeSetting('')).toBe(false)
  })
})

describe('staying awake', () => {
  const s = {
    phoneConnected: false, working: false, paired: false, always: false
  }

  it('lets a Mac with no phone sleep', () => {
    expect(shouldStayAwake({ ...s, always: true })).toBe(false)
  })

  it('holds on while a phone is on the line', () => {
    expect(shouldStayAwake({ ...s, phoneConnected: true })).toBe(true)
  })

  /** The phone is in a pocket and the answer is still coming. */
  it('holds on while an agent is working, even with the switch off', () => {
    expect(shouldStayAwake({ ...s, paired: true, working: true })).toBe(true)
  })

  /** The case the setting exists for: nobody is connected, and the phone must
   *  still be able to come back and find this Mac. */
  it('holds on for a paired Mac left alone', () => {
    expect(shouldStayAwake({ ...s, paired: true, always: true })).toBe(true)
  })

  it('lets a paired Mac sleep once you say so', () => {
    expect(shouldStayAwake({ ...s, paired: true, always: false })).toBe(false)
  })
})
