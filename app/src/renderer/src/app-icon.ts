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
 * `background` is either a CSS colour or an image to cover the icon with.
 * Returns PNG bytes, or null if the canvas is unavailable.
 */
export async function renderAppIcon(background: string | HTMLImageElement): Promise<Uint8Array | null> {
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return null

  // The outer shape clips everything, so a photo cannot spill past the corners.
  roundedRect(ctx, 0, 0, SIZE, SIZE, SIZE * OUTER_RADIUS)
  ctx.clip()

  if (typeof background === 'string') {
    ctx.fillStyle = background
    ctx.fillRect(0, 0, SIZE, SIZE)
  } else {
    // Cover, not stretch: a portrait photo squashed into a square icon looks
    // like a mistake, and cropping is what every avatar does.
    const scale = Math.max(SIZE / background.width, SIZE / background.height)
    const w = background.width * scale
    const h = background.height * scale
    ctx.drawImage(background, (SIZE - w) / 2, (SIZE - h) / 2, w, h)
  }

  // The white square sits on top of either, which is what keeps a custom icon
  // recognisably this app rather than just a cropped photo.
  const inner = SIZE * INNER_SIZE
  const at = (SIZE - inner) / 2
  ctx.fillStyle = INNER_FILL
  roundedRect(ctx, at, at, inner, inner, SIZE * INNER_RADIUS)
  ctx.fill()

  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
  if (!blob) return null
  return new Uint8Array(await blob.arrayBuffer())
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
