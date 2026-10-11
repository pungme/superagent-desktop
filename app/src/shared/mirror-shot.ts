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
