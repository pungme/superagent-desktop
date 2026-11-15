export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/** How much of `win` lies inside any one of `areas` (px²; areas are separate displays, so they are summed). */
export function visibleArea(win: Box, areas: Box[]): number {
  let total = 0
  for (const a of areas) {
    const w = Math.min(win.x + win.width, a.x + a.width) - Math.max(win.x, a.x)
    const h = Math.min(win.y + win.height, a.y + a.height) - Math.max(win.y, a.y)
    if (w > 0 && h > 0) total += w * h
  }
  return total
}

/**
 * A window the user cannot reach: shown, but (nearly) off every display, as it is
 * after the display it was on went away. Clicking the Dock icon "did nothing".
 */
export function offScreen(win: Box, areas: Box[]): boolean {
  if (!areas.length) return false
  const seen = visibleArea(win, areas)
  return seen < Math.min(160 * 160, win.width * win.height * 0.1)
}

/** The window moved onto the first display, kept inside it and no larger than it. */
export function bringOnto(win: Box, area: Box): Box {
  const width = Math.min(win.width, area.width)
  const height = Math.min(win.height, area.height)
  return {
    width,
    height,
    x: area.x + Math.round((area.width - width) / 2),
    y: area.y + Math.round((area.height - height) / 2)
  }
}
