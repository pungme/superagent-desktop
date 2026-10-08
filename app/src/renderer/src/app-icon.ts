/**
 * The app icon, redrawn.
 *
 * The icon is two shapes: a dark rounded square, and a white rounded square in
 * the middle of it. That is the whole design, which is why it can be rebuilt
 * from scratch here rather than shipped as seven pre-rendered files — and why
 * "use my own picture" is the same operation as "use pink", with an image
 * behind the white square instead of a colour.
 *
 * Drawn in the renderer because that is where a canvas is. Main cannot composite
 * (nativeImage has no drawing API) and adding an image library to do it would be
 * a dependency for two rounded rectangles.
 *
 * A caveat worth knowing where it is implemented: this replaces the Dock icon of
 * the running app. Finder and Spotlight keep showing the real one, because that
 * lives in the signed bundle and rewriting it would break the signature.
 */

/** Everything is a fraction of the canvas, so the size is a single decision. */
const SIZE = 1024
/**
 * The icon's own shape is 824 of the canvas's 1024, centred — Apple's icon grid.
 * The Dock draws a replacement icon exactly as handed over, so one painted to
 * the canvas's edges came out a size larger than every icon beside it.
 */
const BOX = 824 / 1024
const OUTER_RADIUS = 0.225
const INNER_SIZE = 0.303
const INNER_RADIUS = 0.083
/** Matches the white in the shipped icon — not pure white; it has a soft edge. */
const INNER_FILL = '#f2f2f4'

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/**
 * Where a picture sits in the icon: how far it is zoomed past "just covers",
 * and how far it is slid off centre, as a fraction (-1…1) of the room there is
 * to slide. Fractions, so the same placement means the same crop at any size.
 */
export interface IconPlace {
  zoom: number
  x: number
  y: number
}
export const CENTRED: IconPlace = { zoom: 1, x: 0, y: 0 }

export function clampPlace(p: Partial<IconPlace> | null | undefined): IconPlace {
  const n = (v: unknown, lo: number, hi: number, d: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d
  return { zoom: n(p?.zoom, 1, 5, 1), x: n(p?.x, -1, 1, 0), y: n(p?.y, -1, 1, 0) }
}

/** The rectangle a w×h picture is drawn into, for an icon box of `box` centred in `size`. */
export function pictureRect(
  w: number,
  h: number,
  size: number,
  box: number,
  place: IconPlace
): { x: number; y: number; w: number; h: number; panX: number; panY: number } {
  const scale = Math.max(box / w, box / h) * place.zoom
  const dw = w * scale
  const dh = h * scale
  // How far it can slide either way before an edge shows.
  const panX = (dw - box) / 2
  const panY = (dh - box) / 2
  return {
    x: (size - dw) / 2 + place.x * panX,
    y: (size - dh) / 2 + place.y * panY,
    w: dw,
    h: dh,
    panX,
    panY
  }
}

/** Paint the icon onto a canvas of any size: the editor's preview and the real thing. */
export function drawAppIcon(
  ctx: CanvasRenderingContext2D,
  size: number,
  background: string | HTMLImageElement | HTMLCanvasElement,
  place: IconPlace = CENTRED
): void {
  const box = size * BOX
  const edge = (size - box) / 2
  ctx.save()
  ctx.clearRect(0, 0, size, size)
  // The outer shape clips everything, so a photo cannot spill past the corners.
  roundedRect(ctx, edge, edge, box, box, box * OUTER_RADIUS)
  ctx.clip()

  if (typeof background === 'string') {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, size, size)
  } else {
    // Cover, not stretch: a portrait photo squashed into a square icon looks
    // like a mistake. Past that, it sits where it was put.
    const r = pictureRect(background.width, background.height, size, box, place)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(background, r.x, r.y, r.w, r.h)
  }

  // The white square sits on top of either, which is what keeps a custom icon
  // recognisably this app rather than just a cropped photo.
  const inner = box * INNER_SIZE
  const at = (size - inner) / 2
  ctx.fillStyle = INNER_FILL
  roundedRect(ctx, at, at, inner, inner, box * INNER_RADIUS)
  ctx.fill()
  ctx.restore()
}

/** The icon's box as a fraction of its canvas, for the editor's arithmetic. */
export const ICON_BOX = BOX

/**
 * `background` is either a CSS colour or an image to cover the icon with.
 * Returns PNG bytes, or null if the canvas is unavailable.
 */
export async function renderAppIcon(
  background: string | HTMLImageElement,
  place: IconPlace = CENTRED
): Promise<Uint8Array | null> {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  drawAppIcon(ctx, SIZE, background, place)
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) return null
  return new Uint8Array(await blob.arrayBuffer())
}

/** A small picture of the icon, for the swatch in Settings that stands for it. */
export function iconThumb(
  background: string | HTMLImageElement,
  place: IconPlace = CENTRED,
  size = 96
): string {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  // Edge to edge here: the swatch is the icon's shape already.
  const full = size / BOX
  ctx.translate((size - full) / 2, (size - full) / 2)
  drawAppIcon(ctx, full, background, place)
  return canvas.toDataURL('image/png')
}

/**
 * A picture small enough to keep. It is stored in the window's preferences,
 * which have a few megabytes in all, and a phone photo alone is more than that.
 */
export function shrinkForKeeping(img: HTMLImageElement, max = 1400): string {
  const scale = Math.min(1, max / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(img.width * scale))
  canvas.height = Math.max(1, Math.round(img.height * scale))
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL('image/jpeg', 0.9)
}

/** A data URL (a kept picture) as something drawable. */
export function loadImageUrl(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('that picture could not be read'))
    img.src = url
  })
}

/** Read a file the user picked into something drawable. */
export function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve(img)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('that file is not an image'))
    }
    img.src = url
  })
}
