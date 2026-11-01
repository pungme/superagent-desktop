import { randomBytes } from 'crypto'
import { describe, expect, it } from 'vitest'
import { REMOTE_FRAME_JPEG_MAX } from '../../shared/remote-control'
import type { WireScreenFrame } from '../../shared/companion-protocol'
import { Sealer, aadFor, deriveKeys } from '../companion/crypto'
import { stringifyForPhone } from '../companion/wire-json'
import {
  BACKLOG_SLOW,
  BACKLOG_STOP,
  DELTA_BUDGET,
  Governor,
  KEY_BUDGET,
  KEY_EVERY_MS,
  ScreenEncoder,
  WIDTHS,
  alignRect,
  dirtyRect,
  mayStream,
  type Bitmap,
  type Rect
} from './stream'

const bitmap = (w: number, h: number, fill = 0): Bitmap => ({
  width: w,
  height: h,
  data: new Uint8Array(w * h * 4).fill(fill)
})
const paint = (b: Bitmap, r: Rect, v: number): void => {
  for (let y = r.y; y < r.y + r.h; y++)
    for (let x = r.x; x < r.x + r.w; x++)
      b.data.fill(v, (y * b.width + x) * 4, (y * b.width + x) * 4 + 4)
}

describe('what changed on the screen', () => {
  it('is null when nothing did', () => {
    expect(dirtyRect(bitmap(64, 48), bitmap(64, 48))).toBeNull()
  })
  it('is the box around every changed pixel', () => {
    const a = bitmap(100, 80)
    const b = bitmap(100, 80)
    paint(b, { x: 10, y: 20, w: 5, h: 3 }, 9)
    paint(b, { x: 60, y: 50, w: 2, h: 2 }, 9)
    expect(dirtyRect(a, b)).toEqual({ x: 10, y: 20, w: 52, h: 32 })
  })
  it('catches a single pixel in a corner', () => {
    const a = bitmap(100, 80)
    const b = bitmap(100, 80)
    paint(b, { x: 99, y: 79, w: 1, h: 1 }, 1)
    expect(dirtyRect(a, b)).toEqual({ x: 99, y: 79, w: 1, h: 1 })
  })
  it('rounds out to whole 8-pixel blocks, inside the picture', () => {
    expect(alignRect({ x: 10, y: 20, w: 5, h: 3 }, 100, 80)).toEqual({ x: 8, y: 16, w: 8, h: 8 })
    expect(alignRect({ x: 97, y: 77, w: 3, h: 3 }, 100, 80)).toEqual({ x: 96, y: 72, w: 4, h: 8 })
  })
})

/** An encoder that costs what its rectangle's area does, and remembers what it was asked. */
const fake = (
  bytesPerPixel = 0.05
): {
  asked: { rect: Rect; quality: number }[]
  encode: (p: Bitmap, r: Rect, q: number) => Buffer
} => {
  const asked: { rect: Rect; quality: number }[] = []
  return {
    asked,
    encode: (_p: Bitmap, rect: Rect, quality: number): Buffer => {
      asked.push({ rect, quality })
      return Buffer.alloc(
        Math.max(100, Math.round(rect.w * rect.h * bytesPerPixel * (quality / 70)))
      )
    }
  }
}

describe('frames', () => {
  it('the first is a whole picture, a still screen sends nothing, a change sends only its box', () => {
    const f = fake()
    const enc = new ScreenEncoder(f.encode)
    const pic = bitmap(200, 100)
    const first = enc.make(pic, 70, 0)
    expect(first).toMatchObject({ frame: { key: true, x: 0, y: 0, rw: 200, rh: 100 } })
    if (first && 'commit' in first) first.commit()
    expect(enc.make(pic, 70, 100)).toBeNull()
    const next = bitmap(200, 100)
    paint(next, { x: 20, y: 10, w: 10, h: 10 }, 7)
    const delta = enc.make(next, 70, 200)
    expect(delta).toMatchObject({ frame: { key: false, x: 16, y: 8, rw: 16, rh: 16, seq: 2 } })
  })

  it('measures against the last frame SENT: one that was never committed is not forgotten', () => {
    const enc = new ScreenEncoder(fake().encode)
    const pic = bitmap(400, 200)
    const first = enc.make(pic, 70, 0)
    if (first && 'commit' in first) first.commit()
    const a = bitmap(400, 200)
    paint(a, { x: 0, y: 0, w: 8, h: 8 }, 1)
    expect(enc.make(a, 70, 10)).not.toBeNull() // made, but dropped by the caller: no commit
    const b = bitmap(400, 200)
    paint(b, { x: 0, y: 0, w: 8, h: 8 }, 1)
    paint(b, { x: 150, y: 80, w: 8, h: 8 }, 2)
    const second = enc.make(b, 70, 20)
    // The box covers the first change too, since the phone never got it.
    expect(second).toMatchObject({ frame: { x: 0, y: 0, rw: 160, rh: 88 } })
  })

  it('is a whole picture when most of it changed, when the size changed, when asked, and every so often', () => {
    const enc = new ScreenEncoder(fake().encode)
    const commit = (m: ReturnType<ScreenEncoder['make']>): void => {
      if (m && 'commit' in m) m.commit()
    }
    commit(enc.make(bitmap(200, 100), 70, 0))
    expect(enc.make(bitmap(200, 100, 9), 70, 10)).toMatchObject({ frame: { key: true } })
    const small = bitmap(200, 100)
    paint(small, { x: 0, y: 0, w: 8, h: 8 }, 1)
    expect(enc.make(small, 70, 20)).toMatchObject({ frame: { key: false } })
    expect(enc.make(bitmap(120, 60, 1), 70, 30)).toMatchObject({ frame: { key: true, w: 120 } })
    enc.needKey()
    expect(enc.make(small, 70, 40)).toMatchObject({ frame: { key: true } })
    const m = enc.make(small, 70, 50)
    commit(m)
    paint(small, { x: 90, y: 90, w: 2, h: 2 }, 5)
    expect(enc.make(small, 70, 50 + KEY_EVERY_MS + 1)).toMatchObject({ frame: { key: true } })
  })

  it('lowers the quality until a frame fits one relay frame, and says so when none can', () => {
    // Noise: 1 byte a pixel at quality 70, so a 1440x900 picture is far over the cap.
    const f = fake(1)
    const enc = new ScreenEncoder(f.encode)
    const made = enc.make(bitmap(1440, 900), 70, 0)
    expect(made).toEqual({ tooBig: true })
    expect(f.asked.map((a) => a.quality)).toEqual([70, 58, 46, 34, 30])
    const small = fake(0.5)
    const ok = new ScreenEncoder(small.encode).make(bitmap(1000, 800), 70, 0)
    expect(ok && 'jpeg' in ok && ok.jpeg.length).toBeLessThanOrEqual(REMOTE_FRAME_JPEG_MAX)
  })
})

describe('the governor', () => {
  it('starts wide and never wider than the display or the phone', () => {
    const g = new Governor()
    expect(g.captureWidth(3000)).toBe(WIDTHS[0])
    expect(g.captureWidth(1000)).toBe(1000)
    g.phoneMax = 800
    expect(g.captureWidth(3000)).toBe(800)
  })
  it('spends less on a whole picture that was too dear, then narrower, and never past the narrowest', () => {
    const g = new Governor()
    for (let i = 0; i < 3; i++) g.after({ key: true, bytes: KEY_BUDGET + 1 })
    expect(g.quality).toBe(48)
    expect(g.level).toBe(0)
    g.after({ key: true, bytes: KEY_BUDGET + 1 })
    expect(g.level).toBe(1)
    for (let i = 0; i < 20; i++) g.after({ key: true, bytes: 0, tooBig: true })
    expect(g.level).toBe(WIDTHS.length - 1)
    expect(g.captureWidth(3000)).toBe(WIDTHS[WIDTHS.length - 1])
  })
  it('a frame that was too big at the floor makes the picture narrower at once', () => {
    const g = new Governor()
    g.after({ key: true, bytes: 0, tooBig: true })
    expect(g.level).toBe(1)
  })
  it('recovers when whole pictures are cheap, quality first and then width', () => {
    const g = new Governor()
    g.after({ key: true, bytes: 0, tooBig: true })
    for (let i = 0; i < 30; i++) g.after({ key: true, bytes: KEY_BUDGET * 0.1 })
    expect(g.level).toBe(0)
    expect(g.quality).toBeLessThanOrEqual(82)
  })
  it('small frames do not move it', () => {
    const g = new Governor()
    g.after({ key: false, bytes: DELTA_BUDGET * 3 })
    expect(g.quality).toBe(72)
  })
  it('waits longer when nothing changes, and much longer when the relay is behind', () => {
    const g = new Governor()
    const busy = g.delay({ changed: true, workMs: 40, backlog: 0 })
    expect(busy).toBe(80)
    const still = g.delay({ changed: false, workMs: 40, backlog: 0 })
    expect(still).toBeGreaterThan(busy)
    for (let i = 0; i < 20; i++) g.delay({ changed: false, workMs: 40, backlog: 0 })
    expect(g.delay({ changed: false, workMs: 40, backlog: 0 })).toBe(400)
    expect(g.delay({ changed: true, workMs: 40, backlog: BACKLOG_SLOW + 1 })).toBe(240)
    expect(g.delay({ changed: true, workMs: 40, backlog: BACKLOG_STOP + 1 })).toBe(1500)
    expect(g.delay({ changed: true, workMs: 300, backlog: 0 })).toBe(375)
    // A dear frame makes the next wait: 100 KB at 250 KB/s is 400 ms; a cheap one does not.
    expect(g.delay({ changed: true, workMs: 40, backlog: 0, bytes: 100_000 })).toBe(400)
    expect(g.delay({ changed: true, workMs: 40, backlog: 0, bytes: 5_000 })).toBe(80)
  })
  it('holds frames back while the relay has too much unsent', () => {
    expect(mayStream(0)).toBe(true)
    expect(mayStream(BACKLOG_SLOW)).toBe(true)
    expect(mayStream(BACKLOG_SLOW + 1)).toBe(false)
  })
})

describe('the relay frame cap', () => {
  it('the largest frame the encoder lets through, sealed and wrapped, is under 1 MB', () => {
    // The relay refuses an envelope of more than 1,048,576 characters (core.ts,
    // LIMITS.maxFrameBytes, checked on the text of {"t":"msg","c":..,"d":..}).
    const jpeg = randomBytes(REMOTE_FRAME_JPEG_MAX)
    const frame: WireScreenFrame = {
      seq: 99999,
      w: 1440,
      h: 900,
      x: 0,
      y: 0,
      rw: 1440,
      rh: 900,
      key: true,
      jpeg: jpeg.toString('base64'),
      cursor: { x: 0.123456789, y: 0.987654321 }
    }
    const keys = deriveKeys(randomBytes(32), 'a'.repeat(64))
    const sealed = new Sealer(keys.m2p, aadFor('a'.repeat(64), 'm2p')).seal(
      stringifyForPhone({ t: 'screen', frame })
    )
    const envelope = JSON.stringify({ t: 'msg', c: 'c-1234567890abcdef', d: sealed })
    expect(envelope.length).toBeLessThan(1_048_576)
    expect(envelope.length).toBeGreaterThan(900_000) // and it is not so far under that the cap is wasted
  })
})
