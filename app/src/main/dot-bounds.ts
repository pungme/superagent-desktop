/** The dot's window: as big as its open panel, the tile at its bottom right. */
export const DOT_W = 420
export const DOT_H = 620
/** The tile's own box inside it: 46px, this far from the right and bottom edges. */
const MARGIN = 18
const TILE = 46

interface Area {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Where the window goes. Left where it was dragged to, as long as the tile is
 * still on a screen: a monitor unplugged since would otherwise leave it out of
 * reach, with nothing to click to get it back. Otherwise the bottom-right
 * corner of the main screen's usable area.
 */
export function dotBounds(
  saved: { x: number; y: number } | null,
  displays: Area[],
  primary: Area
): Area {
  const tile = saved && {
    x: saved.x + DOT_W - MARGIN - TILE,
    y: saved.y + DOT_H - MARGIN - TILE
  }
  const reachable =
    tile &&
    displays.some(
      (d) =>
        tile.x >= d.x &&
        tile.x + TILE <= d.x + d.width &&
        tile.y >= d.y &&
        tile.y + TILE <= d.y + d.height
    )
  const at =
    saved && reachable
      ? saved
      : { x: primary.x + primary.width - DOT_W, y: primary.y + primary.height - DOT_H }
  return { x: Math.round(at.x), y: Math.round(at.y), width: DOT_W, height: DOT_H }
}

/** The corner of the dot's window that the tile, with its hover hint, takes up. */
export const DOT_TILE = 96

/**
 * Whether a point is on the dot, given where its window is: anywhere in the
 * window while the panel is open, else only the tile in the bottom right.
 */
export function pointOnDot(
  b: { x: number; y: number; width: number; height: number },
  panelOpen: boolean,
  x: number,
  y: number
): boolean {
  const inside = x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
  if (!inside) return false
  return panelOpen || (x >= b.x + b.width - DOT_TILE && y >= b.y + b.height - DOT_TILE)
}
