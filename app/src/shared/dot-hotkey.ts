/**
 * The shortcuts the dot can be summoned by. A fixed handful rather than a
 * free-form recorder: each is one a person can hold with one hand and none is
 * a system shortcut, and "pick another" is all that is needed when an app
 * already has the default.
 */
export const DOT_HOTKEYS = [
  { accelerator: 'Alt+Space', label: '⌥ Space' },
  { accelerator: 'Control+Space', label: '⌃ Space' },
  { accelerator: 'Alt+Command+Space', label: '⌥⌘ Space' },
  { accelerator: 'Control+Alt+Space', label: '⌃⌥ Space' },
  { accelerator: 'Alt+Shift+Space', label: '⌥⇧ Space' }
] as const

export const DEFAULT_DOT_HOTKEY = DOT_HOTKEYS[0].accelerator
/** Stored when the user wants no shortcut at all: the tile is clicked instead. */
export const NO_DOT_HOTKEY = 'none'

/** A stored choice as one of the accelerators on offer, the default if it is not one. */
export function dotHotkeyFrom(saved: string | undefined | null): string {
  if (saved === NO_DOT_HOTKEY) return NO_DOT_HOTKEY
  return DOT_HOTKEYS.some((h) => h.accelerator === saved) ? (saved as string) : DEFAULT_DOT_HOTKEY
}

/** How a shortcut is written for a person: "⌥ Space". Empty for none. */
export function dotHotkeyLabel(accelerator: string): string {
  return DOT_HOTKEYS.find((h) => h.accelerator === accelerator)?.label ?? ''
}

export interface DotHotkeyState {
  /** The chosen accelerator, or 'none'. */
  hotkey: string
  /** False when the system refused it: another app has it. True for 'none'. */
  ok: boolean
}

/**
 * The shortcuts for talking to the dot: one press opens it listening, the next
 * sends what was said. Kept apart from the dot's own and the window's, so no
 * two can be set to the same keys.
 */
export const TALK_HOTKEYS = [
  { accelerator: 'Control+Alt+V', label: '⌃⌥ V' },
  { accelerator: 'Control+Alt+Command+V', label: '⌃⌥⌘ V' },
  { accelerator: 'Alt+Shift+V', label: '⌥⇧ V' },
  { accelerator: 'Control+Shift+Space', label: '⌃⇧ Space' }
] as const

export const DEFAULT_TALK_HOTKEY = TALK_HOTKEYS[0].accelerator

export function talkHotkeyFrom(saved: string | undefined | null): string {
  if (saved === NO_DOT_HOTKEY) return NO_DOT_HOTKEY
  return TALK_HOTKEYS.some((h) => h.accelerator === saved) ? (saved as string) : DEFAULT_TALK_HOTKEY
}

export function talkHotkeyLabel(accelerator: string): string {
  return TALK_HOTKEYS.find((h) => h.accelerator === accelerator)?.label ?? ''
}

/**
 * What a press of the talk shortcut does, from what the microphone is doing:
 * start listening, or stop and send what was heard. While the words are being
 * worked out, or the model is loading, a press is ignored rather than queued.
 */
export function talkAction(
  state: 'idle' | 'loading-model' | 'recording' | 'transcribing'
): 'listen' | 'send' | 'wait' {
  return state === 'idle' ? 'listen' : state === 'recording' ? 'send' : 'wait'
}
