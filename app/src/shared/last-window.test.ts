import { describe, expect, it } from 'vitest'
import { afterLastWindow } from './last-window'

describe('what the app does when its last window closes', () => {
  it('stays on a Mac, as apps do', () => {
    expect(afterLastWindow('darwin', false, true)).toBe('stay')
    expect(afterLastWindow('darwin', false, false)).toBe('stay')
  })
  it('does not let a downloaded update turn the close button into a silent quit', () => {
    expect(afterLastWindow('darwin', true, true)).toBe('stay')
    expect(afterLastWindow('darwin', true, false)).toBe('stay')
  })
  it('quits elsewhere', () => {
    expect(afterLastWindow('win32', false, true)).toBe('quit')
    expect(afterLastWindow('linux', true, true)).toBe('quit')
  })
})
