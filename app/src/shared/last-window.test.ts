import { describe, expect, it } from 'vitest'
import { afterLastWindow } from './last-window'

describe('what the app does when its last window closes', () => {
  it('stays on a Mac, as apps do', () => {
    expect(afterLastWindow('darwin', false, true)).toBe('stay')
    expect(afterLastWindow('darwin', false, false)).toBe('stay')
  })
  it('installs a downloaded update: a restart with the dot on, so the dot is back; a quit without', () => {
    expect(afterLastWindow('darwin', true, true)).toBe('restart')
    expect(afterLastWindow('darwin', true, false)).toBe('quit')
  })
  it('quits elsewhere', () => {
    expect(afterLastWindow('win32', false, true)).toBe('quit')
    expect(afterLastWindow('linux', true, true)).toBe('quit')
  })
})
