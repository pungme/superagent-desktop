import { REMOTE_FRAME_JPEG_MAX } from '../../shared/remote-control'

/**
 * The Mac's screen as frames small enough for the relay (one frame is at most
 * 1 MB sealed, see REMOTE_FRAME_JPEG_MAX).
 *
 * A frame is one JPEG of the part of the picture that changed since the last
 * frame that was SENT (the bounding box of the changed pixels), or of the whole
 * picture when most of it changed, when it is the first, when the size changed,
 * every so often, and when the phone says it lost its place. Typing, a cursor
 * blink or a clicked button is a few kilobytes; scrolling a page is a whole
 * frame. The Governor picks the picture's width and the JPEG quality from what
 * the frames really cost, and how long to wait before the next one from how
 * long the last took and how much the relay has not yet taken.
 *
 * Nothing here touches Electron: pixels in, bytes out, so it can be tested and
 * measured without a screen.
 */

/** Four bytes a pixel (BGRA or RGBA: only equality matters here). */
export interface Bitmap {
  width: number
  height: number
  data: Uint8Array
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const asWords = (b: Uint8Array): Uint32Array =>
  b.byteOffset % 4 === 0
    ? new Uint32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4))
    : new Uint32Array(b.slice().buffer)

/** The bounding box of what differs between two pictures of one size, or null when nothing does. */
export function dirtyRect(prev: Bitmap, next: Bitmap): Rect | null {
  const { width, height } = next
  const a = asWords(prev.data)
  const b = asWords(next.data)
  let top = -1
  let bottom = -1
  let left = width
  let right = -1
  for (let y = 0; y < height; y++) {
    const row = y * width
    let x0 = 0
    while (x0 < width && a[row + x0] === b[row + x0]) x0++
    if (x0 === width) continue
    let x1 = width - 1
    while (x1 > x0 && a[row + x1] === b[row + x1]) x1--
    if (top < 0) top = y
    bottom = y
    if (x0 < left) left = x0
    if (x1 > right) right = x1
  }
  if (top < 0) return null
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 }
}

/** The rectangle grown to whole 8-pixel blocks (a JPEG's own grid), held inside the picture. */
export function alignRect(r: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.floor(r.x / 8) * 8)
  const y0 = Math.max(0, Math.floor(r.y / 8) * 8)
  const x1 = Math.min(width, Math.ceil((r.x + r.w) / 8) * 8)
  const y1 = Math.min(height, Math.ceil((r.y + r.h) / 8) * 8)
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** More than this much of the picture changed: send the whole of it. */
const KEY_ABOVE = 0.55
/** A whole picture at least this often while it changes, so a missed frame cannot linger. */
export const KEY_EVERY_MS = 12_000
/** The lowest JPEG quality tried before a frame is given up on (and the picture made smaller). */
const QUALITY_FLOOR = 30

export interface Made {
  frame: {
    seq: number
    w: number
    h: number
    x: number
    y: number
    rw: number
    rh: number
    key: boolean
  }
  jpeg: Buffer
  /** Call once the frame has been handed to the relay: it is now what later frames are measured against. */
  commit: () => void
}

export type Encode = (picture: Bitmap, rect: Rect, quality: number) => Buffer

export class ScreenEncoder {
  private held: Bitmap | null = null
  private seq = 0
  private keyAt = 0
  private wantKey = true

  constructor(private encode: Encode) {}

  /** The next frame is a whole picture. */
  needKey(): void {
    this.wantKey = true
  }

  /**
   * The frame for this picture, or null when nothing changed since the last one
   * sent. `tooBig` when even the lowest quality does not fit one relay frame:
   * the caller makes the picture smaller. Nothing is remembered until `commit`.
   */
  make(picture: Bitmap, quality: number, now: number): Made | { tooBig: true } | null {
    const same =
      this.held && this.held.width === picture.width && this.held.height === picture.height
    let rect: Rect | null = { x: 0, y: 0, w: picture.width, h: picture.height }
    let key = !same || this.wantKey
    if (same && !key) {
      rect = dirtyRect(this.held!, picture)
      if (!rect) return null
      const area = rect.w * rect.h
      if (area > KEY_ABOVE * picture.width * picture.height || now - this.keyAt > KEY_EVERY_MS)
        key = true
      else rect = alignRect(rect, picture.width, picture.height)
    }
    if (key) rect = { x: 0, y: 0, w: picture.width, h: picture.height }
    let q = quality
    let jpeg = this.encode(picture, rect!, q)
    while (jpeg.length > REMOTE_FRAME_JPEG_MAX && q > QUALITY_FLOOR) {
      q = Math.max(QUALITY_FLOOR, q - 12)
      jpeg = this.encode(picture, rect!, q)
    }
    if (jpeg.length > REMOTE_FRAME_JPEG_MAX) return { tooBig: true }
    const seq = ++this.seq
    return {
      frame: {
        seq,
        w: picture.width,
        h: picture.height,
        x: rect!.x,
        y: rect!.y,
        rw: rect!.w,
        rh: rect!.h,
        key
      },
      jpeg,
      commit: () => {
        // A copy: the capture's own buffer is reused by the next one.
        this.held = { width: picture.width, height: picture.height, data: picture.data.slice() }
        if (key) {
          this.keyAt = now
          this.wantKey = false
        }
      }
    }
  }
}

/** Widths the picture is made at, widest first. */
export const WIDTHS = [1440, 1152, 960, 768, 640]
/** What a frame should cost, in JPEG bytes: a piece of the screen, and a whole picture. */
export const DELTA_BUDGET = 120_000
export const KEY_BUDGET = 260_000
const MIN_INTERVAL_MS = 80
const MAX_INTERVAL_MS = 400
/**
 * The most a stream is allowed to average, in bytes a second. The relay keeps
 * a day's allowance per Mac (500 MB) and a request cap behind it, and a
 * moving screen at full speed would spend the first in half an hour. A frame
 * costing more than this a second's worth makes the next wait for it.
 */
export const MAX_BYTES_PER_SECOND = 250_000
/** More than this unsent on the relay's socket and frames wait. */
export const BACKLOG_SLOW = 256 * 1024
export const BACKLOG_STOP = 1024 * 1024

export class Governor {
  private idx = 0
  quality = 72
  private cheapKeys = 0
  private still = 0
  /** The widest the phone can use; 0 for no limit. */
  phoneMax = 0

  /** The width to capture a display `displayWidth` wide at. Never wider than the display. */
  captureWidth(displayWidth: number): number {
    const cap = this.phoneMax > 0 ? this.phoneMax : Infinity
    const w = Math.min(displayWidth, cap, WIDTHS[this.idx])
    return Math.max(320, Math.round(w))
  }

  get level(): number {
    return this.idx
  }

  /** What the last frame cost. */
  after(r: { key: boolean; bytes: number; tooBig?: boolean }): void {
    const narrower = (): void => {
      if (this.idx < WIDTHS.length - 1) this.idx++
      this.quality = 70
      this.cheapKeys = 0
    }
    if (r.tooBig) {
      narrower()
      return
    }
    if (!r.key) return
    if (r.bytes > KEY_BUDGET) {
      this.cheapKeys = 0
      if (this.quality > 48) this.quality = Math.max(48, this.quality - 8)
      else narrower()
    } else if (r.bytes < KEY_BUDGET * 0.4) {
      if (++this.cheapKeys >= 3) {
        this.cheapKeys = 0
        if (this.quality < 80) this.quality = Math.min(82, this.quality + 6)
        else if (this.idx > 0) {
          this.idx--
          this.quality = 70
        }
      }
    } else this.cheapKeys = 0
  }

  /**
   * Milliseconds before the next look. `workMs` is what the last look cost
   * (capture and encode), `backlog` what the relay has not taken yet, `bytes`
   * what the frame just sent cost.
   */
  delay(r: { changed: boolean; workMs: number; backlog: number; bytes?: number }): number {
    this.still = r.changed ? 0 : this.still + 1
    let ms = Math.max(MIN_INTERVAL_MS, Math.round(r.workMs * 1.25))
    // Paying for the last frame: not faster than the average allowed.
    if (r.bytes) ms = Math.max(ms, Math.round((r.bytes / MAX_BYTES_PER_SECOND) * 1000))
    if (!r.changed) ms = Math.min(MAX_INTERVAL_MS, ms + 60 * this.still)
    if (r.backlog > BACKLOG_STOP) ms = Math.max(ms, 1500)
    else if (r.backlog > BACKLOG_SLOW) ms *= 3
    return ms
  }
}

/** Whether a frame may be handed to the relay now. */
export function mayStream(backlog: number): boolean {
  return backlog <= BACKLOG_SLOW
}
