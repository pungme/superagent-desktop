import { expect, it } from 'vitest'
import { DEFAULT_DOT_HOTKEY, dotHotkeyFrom, dotHotkeyLabel, NO_DOT_HOTKEY } from './dot-hotkey'

it('reads a stored shortcut, falling back to the default for anything else', () => {
  expect(dotHotkeyFrom('Control+Space')).toBe('Control+Space')
  expect(dotHotkeyFrom(undefined)).toBe(DEFAULT_DOT_HOTKEY)
  expect(dotHotkeyFrom('Command+Q')).toBe(DEFAULT_DOT_HOTKEY)
  // Having none is a choice, not a missing value.
  expect(dotHotkeyFrom(NO_DOT_HOTKEY)).toBe(NO_DOT_HOTKEY)
})

it('writes a shortcut the way a person reads it', () => {
  expect(dotHotkeyLabel('Alt+Space')).toBe('⌥ Space')
  expect(dotHotkeyLabel('Alt+Command+Space')).toBe('⌥⌘ Space')
  expect(dotHotkeyLabel(NO_DOT_HOTKEY)).toBe('')
})
