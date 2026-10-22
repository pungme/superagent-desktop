import { describe, expect, it } from 'vitest'
import {
  SPLIT_GAP,
  dropPlan,
  fits,
  layoutRects,
  neighbour,
  parseSplits,
  prunedSplits,
  resized,
  splitRects,
  withTile,
  withoutTile,
  type Split
} from './split'

const A = { ws: 'w1', chat: 'a' }
const B = { ws: 'w1', chat: 'b' }
const C = { ws: 'w2', chat: 'c' }
const D = { ws: 'w3', chat: 'd' }
const E = { ws: 'w3', chat: 'e' }
const split = (tiles = [A, B], extra: Partial<Split> = {}): Split => ({
  id: 's',
  tiles,
  focus: 0,
  orient: 'row',
  fr: null,
  zoom: null,
  ...extra
})

describe('where the windows go', () => {
  it('splits the width in a row, the height in a stack, with a gap between', () => {
    const row = layoutRects(2, 1000, 600)
    expect(row[0]).toEqual({ x: 0, y: 0, w: (1000 - SPLIT_GAP) / 2, h: 600 })
    expect(row[1].x).toBe((1000 - SPLIT_GAP) / 2 + SPLIT_GAP)
    const col = layoutRects(3, 1000, 600, 'col')
    expect(col.map((r) => r.w)).toEqual([1000, 1000, 1000])
    expect(col[2].y + col[2].h).toBeCloseTo(600)
  })

  it('puts four in a 2×2 grid, whatever the orientation', () => {
    const g = layoutRects(4, 1000, 600, 'col')
    expect(g[1].x).toBeGreaterThan(0)
    expect(g[2].y).toBeGreaterThan(0)
    expect(g[3].x + g[3].w).toBeCloseTo(1000)
  })

  it('honours shares, and ignores broken ones', () => {
    const r = layoutRects(2, 1008, 600, 'row', [2, 1])
    expect(r[0].w).toBeCloseTo(2 * r[1].w)
    expect(layoutRects(2, 1000, 600, 'row', [0, 1])[0].w).toBeCloseTo(496)
  })

  it('shows only the zoomed window, full size', () => {
    const r = splitRects(split([A, B, C], { zoom: 1 }), 900, 500)
    expect(r[0]).toBeNull()
    expect(r[1]).toEqual({ x: 0, y: 0, w: 900, h: 500 })
  })

  it('knows when side by side would be too narrow', () => {
    expect(fits(2, 700, 800, 'row')).toBe(true)
    expect(fits(3, 700, 800, 'row')).toBe(false)
    expect(fits(3, 700, 800, 'col')).toBe(true)
  })
})

describe('changing a split', () => {
  it('opens a chat beside, focused, and moves one already there', () => {
    const s = withTile(split(), C, 1)!
    expect(s.tiles).toEqual([A, C, B])
    expect(s.focus).toBe(1)
    expect(withTile(s, A, 3)!.tiles).toEqual([C, B, A])
  })

  it('never takes a fifth', () => {
    expect(withTile(split([A, B, C, D]), E, 4)).toBeNull()
  })

  it('takes one away and keeps the focus sensible', () => {
    const s = withoutTile(split([A, B, C], { focus: 2 }), 0)
    expect(s.tiles).toEqual([B, C])
    expect(s.focus).toBe(1)
    expect(withoutTile(split([A, B], { focus: 1 }), 1).focus).toBe(0)
  })

  it('resizes two neighbours and never below the minimum', () => {
    const f = resized(null, 2, 0, 100, 1008, 300)
    expect(f[0] / f[1]).toBeCloseTo(600 / 400)
    const tight = resized(null, 2, 0, 1000, 1008, 300)
    expect((tight[1] * 1000) / (tight[0] + tight[1])).toBeCloseTo(300)
  })
})

describe('dropping a chat on the windows', () => {
  it('opens beside on the nearer side', () => {
    expect(dropPlan([A], 'row', C, 900, 300, 1000, 600)).toMatchObject({
      kind: 'insert',
      tiles: [A, C],
      at: 1
    })
    expect(dropPlan([A], 'row', C, 100, 300, 1000, 600)).toMatchObject({ tiles: [C, A], at: 0 })
  })

  it('stacks when dropped near the top or bottom of the only window', () => {
    expect(dropPlan([A], 'row', C, 500, 40, 1000, 600)).toMatchObject({
      tiles: [C, A],
      orient: 'col'
    })
    expect(dropPlan([A], 'row', C, 500, 560, 1000, 600)).toMatchObject({
      tiles: [A, C],
      orient: 'col'
    })
  })

  it('never replaces: a full split says so', () => {
    expect(dropPlan([A, B, C, D], 'row', E, 100, 100, 1000, 600)).toEqual({ kind: 'full' })
  })

  it('moves a window that is already there instead of adding it twice', () => {
    const p = dropPlan([A, B, C], 'row', A, 990, 300, 1000, 600)
    expect(p).toMatchObject({ kind: 'insert', tiles: [B, C, A] })
  })

  it('ignores a drop outside the windows', () => {
    expect(dropPlan([A], 'row', C, -5, 10, 1000, 600)).toBeNull()
  })
})

describe('moving between windows by direction', () => {
  it('finds the window to the left, right, above or below', () => {
    const r = layoutRects(4, 1000, 600)
    expect(neighbour(r, 0, 1, 0)).toBe(1)
    expect(neighbour(r, 0, 0, 1)).toBe(2)
    expect(neighbour(r, 3, -1, 0)).toBe(2)
    expect(neighbour(r, 0, -1, 0)).toBe(-1)
  })
})

describe('saved splits', () => {
  it('reads back good records and drops bad ones', () => {
    const raw = JSON.stringify([
      split([A, B], { focus: 9, fr: [1, 2], zoom: 1 }),
      { id: 'one', tiles: [A] },
      { id: 'bad', tiles: [A, { ws: 1 }] },
      'nonsense'
    ])
    const got = parseSplits(raw)
    expect(got).toHaveLength(1)
    expect(got[0].focus).toBe(1)
    expect(got[0].zoom).toBeNull()
    expect(got[0].fr).toEqual([1, 2])
    expect(parseSplits('{not json')).toEqual([])
  })

  it('drops chats that are gone, and splits left with one', () => {
    const list = [split([A, B, C]), split([A, D], { id: 't' })]
    const out = prunedSplits(list, (t) => t.chat !== 'a')
    expect(out).toHaveLength(1)
    expect(out[0].tiles).toEqual([B, C])
  })
})
