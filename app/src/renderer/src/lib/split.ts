/**
 * Split view: several conversations in the window at once, as a saved group.
 *
 * Arc's model: two to four chats on screen form a split; a split is one row in
 * the sidebar you can leave and come back to; showing any other chat leaves the
 * split (it waits in the sidebar) and nothing is ever replaced. This file is the
 * pure part — the shape, the layout maths, the edits — so it is tested without
 * a window. The store keeps the current split and the saved ones.
 */

export const SPLIT_MAX = 4
/** The gap between windows, in px. Also the handle you drag to resize. */
export const SPLIT_GAP = 8
/** Narrower than this, a window or a stack row is not worth having. */
export const MIN_TILE_W = 300
export const MIN_TILE_H = 200

export interface SplitTile {
  ws: string
  chat: string
}

export type SplitOrient = 'row' | 'col'

export interface Split {
  id: string
  tiles: SplitTile[]
  /** The window keys and menus go to. */
  focus: number
  /** Side by side or stacked; only for two or three (four is a 2×2 grid). */
  orient: SplitOrient
  /** Each window's share along the orientation; null is equal shares. */
  fr: number[] | null
  /** One window shown full size for a moment (⌘⇧↩), or null. */
  zoom: number | null
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const sameTile = (a: SplitTile, b: SplitTile): boolean => a.ws === b.ws && a.chat === b.chat

export function tileIndex(
  split: Split | null,
  ws: string | null,
  chat: string | undefined
): number {
  if (!split || !ws || !chat) return -1
  return split.tiles.findIndex((t) => t.ws === ws && t.chat === chat)
}

/** Where each window sits in a canvas of this size. */
export function layoutRects(
  n: number,
  w: number,
  h: number,
  orient: SplitOrient = 'row',
  fr: number[] | null = null
): Rect[] {
  if (n <= 0) return []
  if (n === 1) return [{ x: 0, y: 0, w, h }]
  if (n <= 3) {
    const f = fr && fr.length === n && fr.every((k) => k > 0) ? fr : Array(n).fill(1)
    const sum = f.reduce((a, b) => a + b, 0)
    const total = (orient === 'col' ? h : w) - SPLIT_GAP * (n - 1)
    let at = 0
    return f.map((k) => {
      const size = (total * k) / sum
      const r = orient === 'col' ? { x: 0, y: at, w, h: size } : { x: at, y: 0, w: size, h }
      at += size + SPLIT_GAP
      return r
    })
  }
  const cw = (w - SPLIT_GAP) / 2
  const ch = (h - SPLIT_GAP) / 2
  return [
    { x: 0, y: 0, w: cw, h: ch },
    { x: cw + SPLIT_GAP, y: 0, w: cw, h: ch },
    { x: 0, y: ch + SPLIT_GAP, w: cw, h: ch },
    { x: cw + SPLIT_GAP, y: ch + SPLIT_GAP, w: cw, h: ch }
  ]
}

/** The rectangles for a split, honouring a zoomed window. Null for one not shown. */
export function splitRects(split: Split, w: number, h: number): (Rect | null)[] {
  if (split.zoom !== null && split.tiles[split.zoom])
    return split.tiles.map((_, i) => (i === split.zoom ? { x: 0, y: 0, w, h } : null))
  return layoutRects(split.tiles.length, w, h, split.orient, split.fr)
}

/**
 * Two or three windows side by side need room; a window too narrow for its
 * chat is worse than a stack. Below this canvas width a new split stacks.
 */
export function fits(n: number, w: number, h: number, orient: SplitOrient): boolean {
  if (n <= 1) return true
  if (n >= 4) return w >= 2 * MIN_TILE_W + SPLIT_GAP && h >= 2 * MIN_TILE_H + SPLIT_GAP
  return orient === 'col'
    ? h >= n * MIN_TILE_H + (n - 1) * SPLIT_GAP
    : w >= n * MIN_TILE_W + (n - 1) * SPLIT_GAP
}

/** A new id for a split. */
export function newSplitId(): string {
  return `split-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** A chat put in at `at`; a chat already in the split moves there. Null when full. */
export function withTile(split: Split, tile: SplitTile, at: number): Split | null {
  const rest = split.tiles.filter((t) => !sameTile(t, tile))
  if (rest.length >= SPLIT_MAX) return null
  const i = Math.max(0, Math.min(at, rest.length))
  const tiles = [...rest.slice(0, i), tile, ...rest.slice(i)]
  return {
    ...split,
    tiles,
    focus: i,
    fr: tiles.length === split.tiles.length ? split.fr : null,
    zoom: null
  }
}

/** The window at `i` taken off screen. One window left is no longer a split. */
export function withoutTile(split: Split, i: number): Split {
  const tiles = split.tiles.filter((_, k) => k !== i)
  const focus =
    split.focus > i ? split.focus - 1 : split.focus === i ? Math.max(0, i - 1) : split.focus
  return { ...split, tiles, focus: Math.min(focus, tiles.length - 1), fr: null, zoom: null }
}

/** New shares after dragging the gap after window `k` by `px`. */
export function resized(
  fr: number[] | null,
  n: number,
  k: number,
  px: number,
  total: number,
  min: number
): number[] {
  const f = fr && fr.length === n ? fr.slice() : Array(n).fill(1)
  const sum = f.reduce((a, b) => a + b, 0)
  const avail = total - SPLIT_GAP * (n - 1)
  const a = (f[k] * avail) / sum
  const b = (f[k + 1] * avail) / sum
  const na = Math.max(min, Math.min(a + b - min, a + px))
  f[k] = (na * sum) / avail
  f[k + 1] = ((a + b - na) * sum) / avail
  return f
}

/**
 * Where a chat dragged over the canvas would go, or why not.
 *
 * With room left a drop always opens beside — on the nearer side, or, over the
 * only window, stacked when dropped near its top or bottom (as in Arc). A full
 * split never replaces a window by a drag: it says so instead.
 */
export type DropPlan =
  { kind: 'insert'; tiles: SplitTile[]; at: number; orient: SplitOrient } | { kind: 'full' } | null

export function dropPlan(
  current: SplitTile[],
  orient: SplitOrient,
  dragged: SplitTile,
  x: number,
  y: number,
  w: number,
  h: number
): DropPlan {
  if (x < 0 || y < 0 || x > w || y > h) return null
  const base = current.filter((t) => !sameTile(t, dragged))
  if (base.length === 0) return null
  if (base.length >= SPLIT_MAX) return { kind: 'full' }
  const rects = layoutRects(base.length, w, h, orient)
  const hit = rects.findIndex((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)
  if (hit < 0) return null
  const r = rects[hit]
  const fx = (x - r.x) / r.w
  const fy = (y - r.y) / r.h
  const nextOrient: SplitOrient =
    base.length === 1
      ? fx > 0.25 && fx < 0.75 && (fy < 0.25 || fy > 0.75)
        ? 'col'
        : 'row'
      : orient
  const before = nextOrient === 'col' && base.length < 3 ? fy < 0.5 : fx < 0.5
  const at = before ? hit : hit + 1
  const tiles = [...base.slice(0, at), dragged, ...base.slice(at)]
  return { kind: 'insert', tiles, at, orient: tiles.length >= 4 ? orient : nextOrient }
}

/** The neighbour of window `from` in a direction, by the centres of the windows. */
export function neighbour(rects: (Rect | null)[], from: number, dx: number, dy: number): number {
  const cur = rects[from]
  if (!cur) return -1
  const cx = cur.x + cur.w / 2
  const cy = cur.y + cur.h / 2
  let best = -1
  let bd = Infinity
  rects.forEach((r, i) => {
    if (!r || i === from) return
    const x = r.x + r.w / 2 - cx
    const y = r.y + r.h / 2 - cy
    if (dx && (Math.sign(x) !== dx || Math.abs(x) < 5)) return
    if (dy && (Math.sign(y) !== dy || Math.abs(y) < 5)) return
    const d = Math.abs(x) + Math.abs(y)
    if (d < bd) {
      bd = d
      best = i
    }
  })
  return best
}

/** Saved splits, read back defensively: a bad record is dropped, not trusted. */
export function parseSplits(raw: string | null): Split[] {
  try {
    const list = JSON.parse(raw || '[]') as Split[]
    if (!Array.isArray(list)) return []
    return list
      .filter(
        (s) =>
          s &&
          typeof s.id === 'string' &&
          Array.isArray(s.tiles) &&
          s.tiles.length >= 2 &&
          s.tiles.every((t) => t && typeof t.ws === 'string' && typeof t.chat === 'string')
      )
      .map((s) => ({
        id: s.id,
        tiles: s.tiles.slice(0, SPLIT_MAX).map((t) => ({ ws: t.ws, chat: t.chat })),
        focus: Math.min(Math.max(0, Number(s.focus) || 0), Math.min(s.tiles.length, SPLIT_MAX) - 1),
        orient: s.orient === 'col' ? 'col' : 'row',
        fr: Array.isArray(s.fr) && s.fr.length === s.tiles.length ? s.fr.map(Number) : null,
        zoom: null
      }))
  } catch {
    return []
  }
}

/** Drop chats that no longer exist; a split left with one is no split. */
export function prunedSplits(list: Split[], alive: (t: SplitTile) => boolean): Split[] {
  return list
    .map((s) => {
      const tiles = s.tiles.filter(alive)
      if (tiles.length === s.tiles.length) return s
      return { ...s, tiles, focus: Math.min(s.focus, tiles.length - 1), fr: null, zoom: null }
    })
    .filter((s) => s.tiles.length >= 2)
}
