/**
 * The shortcuts that bring Superagent's own window forward from any app. A
 * fixed handful, like the dot's: none is a system shortcut, and "pick another"
 * is all that is needed when an app already has one.
 */
export const APP_HOTKEYS = [
  { accelerator: 'Control+Alt+S', label: '⌃⌥ S' },
  { accelerator: 'Alt+Command+S', label: '⌥⌘ S' },
  { accelerator: 'Control+Alt+Command+S', label: '⌃⌥⌘ S' },
  { accelerator: 'Control+Alt+Command+Space', label: '⌃⌥⌘ Space' },
  { accelerator: 'Alt+Shift+S', label: '⌥⇧ S' }
] as const

export const DEFAULT_APP_HOTKEY = APP_HOTKEYS[0].accelerator
/** Stored when the user wants no shortcut. */
export const NO_APP_HOTKEY = 'none'

/** A stored choice as one of the accelerators on offer, the default if it is not one. */
export function appHotkeyFrom(saved: string | undefined | null): string {
  if (saved === NO_APP_HOTKEY) return NO_APP_HOTKEY
  return APP_HOTKEYS.some((h) => h.accelerator === saved) ? (saved as string) : DEFAULT_APP_HOTKEY
}

/** How a shortcut is written for a person: "⌃⌥ S". Empty for none. */
export function appHotkeyLabel(accelerator: string): string {
  return APP_HOTKEYS.find((h) => h.accelerator === accelerator)?.label ?? ''
}

export interface AppHotkeyState {
  /** The chosen accelerator, or 'none'. */
  hotkey: string
  /** False when the system refused it: another app has it. True for 'none'. */
  ok: boolean
}

/**
 * What a press does, from what the window is doing: in front and focused, it
 * steps aside (the shortcut is a toggle); anything else brings it forward.
 */
export function appHotkeyAction(w: {
  exists: boolean
  visible: boolean
  focused: boolean
  minimized: boolean
}): 'create' | 'hide' | 'show' {
  if (!w.exists) return 'create'
  return w.visible && w.focused && !w.minimized ? 'hide' : 'show'
}
