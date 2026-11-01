/**
 * Who may flip the switches ("Let my phone control this Mac", "Allow shells"),
 * as rules with nothing of Electron in them so they are tested with fakes.
 */

/** The parts of an IPC event that say who is asking. */
export interface Asker {
  /** The frame that sent it. */
  senderFrame: unknown
  sender: { mainFrame: unknown }
}

/**
 * Only the top frame of the app's own main window: not a sub-frame, not the
 * dot's window, not a window that has gone. One script injected into the chat
 * renderer must not be able to turn this on without someone at the Mac.
 */
export function trustedSender(
  e: Asker,
  window: { isDestroyed(): boolean } | null,
  isDot: boolean
): boolean {
  return !!window && !window.isDestroyed() && !isDot && e.senderFrame === e.sender.mainFrame
}

/**
 * Whether a switch change goes ahead. Turning on, or allowing shells, asks at
 * the Mac in a native dialog (Cancel is the default); turning off needs no
 * question. Nobody untrusted changes anything, either way.
 */
export async function mayFlip(opts: {
  trusted: boolean
  on: boolean
  confirm: () => Promise<boolean>
}): Promise<boolean> {
  if (!opts.trusted) return false
  if (!opts.on) return true
  return opts.confirm()
}
