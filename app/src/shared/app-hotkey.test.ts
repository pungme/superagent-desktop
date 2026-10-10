import { describe, expect, it } from 'vitest'
import {
  APP_HOTKEYS,
  DEFAULT_APP_HOTKEY,
  NO_APP_HOTKEY,
  appHotkeyAction,
  appHotkeyFrom,
  appHotkeyLabel
} from './app-hotkey'
import { DOT_HOTKEYS } from './dot-hotkey'

describe("the shortcut that brings Superagent's window forward", () => {
  it('is one of the handful on offer, the default when it is not', () => {
    expect(appHotkeyFrom(undefined)).toBe(DEFAULT_APP_HOTKEY)
    expect(appHotkeyFrom('Command+Q')).toBe(DEFAULT_APP_HOTKEY)
    expect(appHotkeyFrom('Alt+Command+S')).toBe('Alt+Command+S')
    expect(appHotkeyFrom(NO_APP_HOTKEY)).toBe(NO_APP_HOTKEY)
  })
  it('is written the way the keys are labelled', () => {
    expect(appHotkeyLabel('Control+Alt+S')).toBe('⌃⌥ S')
    expect(appHotkeyLabel(NO_APP_HOTKEY)).toBe('')
  })
  it("never offers one of the dot's, so the two cannot be set to the same keys", () => {
    const dots = DOT_HOTKEYS.map((h) => h.accelerator as string)
    expect(APP_HOTKEYS.filter((h) => dots.includes(h.accelerator))).toEqual([])
  })
  it('brings the window forward, and steps aside when it is already in front', () => {
    const w = { exists: true, visible: true, focused: true, minimized: false }
    expect(appHotkeyAction(w)).toBe('hide')
    expect(appHotkeyAction({ ...w, focused: false })).toBe('show')
    expect(appHotkeyAction({ ...w, minimized: true })).toBe('show')
    expect(appHotkeyAction({ ...w, visible: false })).toBe('show')
    expect(appHotkeyAction({ ...w, exists: false })).toBe('create')
  })
})
