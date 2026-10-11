/**
 * How wide a picture of the page the phone is sent. 700 unless it asks for
 * more, which it does when the page is full screen and can be zoomed into: at
 * 700 a desktop page pinched to three times its size is a blur. Never past
 * 1400; the size in bytes is held down separately (MIRROR_IMAGE_BYTES).
 */
export function mirrorShotWidth(asked: number | undefined): number {
  if (!asked || !Number.isFinite(asked)) return 700
  return Math.max(200, Math.min(Math.round(asked), 1400))
}

export interface Size {
  width: number
  height: number
}

/**
 * The size a page is laid out at while it composites unseen, for the phone to
 * take a picture of. It used to be the whole window, which gave the phone a
 * page shaped like the window: wide and short, nothing like the column the
 * pane is on the Mac. Now it is the pane's own size the last time it was on
 * screen, held within the window as it is now; and for a page the Mac has not
 * shown yet, a column the shape the pane would have: half the window's width,
 * its full height.
 */
export function unseenPaneSize(shown: Size | null | undefined, window: Size): Size {
  const w = Math.max(320, window.width)
  const h = Math.max(240, window.height)
  const wanted =
    shown && shown.width > 0 && shown.height > 0 ? shown : { width: Math.round(w / 2), height: h }
  return {
    width: Math.max(320, Math.min(Math.round(wanted.width), w)),
    height: Math.max(240, Math.min(Math.round(wanted.height), h))
  }
}
