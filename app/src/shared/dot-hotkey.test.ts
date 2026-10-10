import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DOT_HOTKEY,
  DOT_HOTKEYS,
  dotHotkeyFrom,
  dotHotkeyLabel,
  NO_DOT_HOTKEY
} from './dot-hotkey'

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

describe('the shortcut for talking to the dot', () => {
  it("is one of its own handful, none of them the dot's or the window's", async () => {
    const { TALK_HOTKEYS, talkHotkeyFrom, DEFAULT_TALK_HOTKEY } = await import('./dot-hotkey')
    const { APP_HOTKEYS } = await import('./app-hotkey')
    const others = [...DOT_HOTKEYS, ...APP_HOTKEYS].map((h) => h.accelerator as string)
    expect(TALK_HOTKEYS.filter((h) => others.includes(h.accelerator))).toEqual([])
    expect(talkHotkeyFrom(undefined)).toBe(DEFAULT_TALK_HOTKEY)
    expect(talkHotkeyFrom('Alt+Space')).toBe(DEFAULT_TALK_HOTKEY)
    expect(talkHotkeyFrom('none')).toBe('none')
  })
  it('listens on the first press, sends on the next, and waits while it is thinking', async () => {
    const { talkAction } = await import('./dot-hotkey')
    expect(talkAction('idle')).toBe('listen')
    expect(talkAction('recording')).toBe('send')
    expect(talkAction('transcribing')).toBe('wait')
    expect(talkAction('loading-model')).toBe('wait')
  })
})
