import type { BrowserWindow, View } from 'electron'

/**
 * Views that must stay above the page views of their window (the floating chat).
 *
 * A browser pane is attached with addChildView, which puts it on top of
 * everything already there: attaching a page after the floating chat would
 * cover the chat. Whoever attaches a page calls raiseOverlays afterwards.
 */
const onTop = new Map<number, Set<View>>()

export function keepOnTop(win: BrowserWindow, view: View): void {
  let set = onTop.get(win.id)
  if (!set) {
    set = new Set()
    onTop.set(win.id, set)
    win.once('closed', () => onTop.delete(win.id))
  }
  set.add(view)
  raiseOverlays(win)
}

/** Put the window's overlays back on top, after a page view was attached. */
export function raiseOverlays(win: BrowserWindow): void {
  if (win.isDestroyed()) return
  const set = onTop.get(win.id)
  if (!set) return
  const children = win.contentView.children
  for (const view of set) {
    // Already the topmost: nothing to move (moving it would make it flicker).
    if (children[children.length - 1] === view && set.size === 1) continue
    win.contentView.addChildView(view)
  }
}
