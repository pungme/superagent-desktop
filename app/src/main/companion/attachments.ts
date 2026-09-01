import { app, nativeImage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'

/**
 * Thumbnails of the pictures a message was sent with.
 *
 * The bytes of an attachment go to the agent, not into the event log — the log
 * records only how many there were and how big. That is the right call: a
 * conversation replayed on three devices should not drag its attachments across
 * the relay three times. But it left every device except the sender showing a
 * message whose picture it had never seen, because the only copies were the
 * sender's own: the phone's `SentImages` cache, or data URLs in a renderer.
 *
 * So the Mac — which every device already talks to — keeps one small thumbnail
 * per image, and hands it over when somebody actually looks. Small enough to
 * cross the relay in one frame, kept beside the log rather than in it.
 */

const LONG_EDGE = 600
const QUALITY = 70
/** Roughly a year of ordinary use; the oldest go first when it grows past this. */
const MAX_FILES = 4000

function dir(): string {
  const d = join(app.getPath('userData'), 'attachments')
  mkdirSync(d, { recursive: true })
  return d
}

/** The id is ours, but a path is a path: never let one walk out of its folder. */
function fileFor(messageId: string, index: number): string {
  const safe = messageId.replace(/[^\w.-]/g, '_').slice(0, 120)
  return join(dir(), `${safe}-${index}.jpg`)
}

export interface StoredImage {
  mediaType: string
  /** base64, no data: prefix */
  data: string
}

/**
 * Remember what a message was sent with, keyed by the id the event carries, so
 * any device replaying that event can ask for it later.
 */
export function keepThumbnails(
  messageId: string,
  images: { mediaType: string; data: string }[]
): void {
  if (!messageId || images.length === 0) return
  try {
    images.forEach((im, i) => {
      let img = nativeImage.createFromBuffer(Buffer.from(im.data, 'base64'))
      if (img.isEmpty()) return
      const { width, height } = img.getSize()
      const longest = Math.max(width, height)
      if (longest > LONG_EDGE) {
        img =
          width >= height
            ? img.resize({ width: LONG_EDGE })
            : img.resize({ height: LONG_EDGE })
      }
      writeFileSync(fileFor(messageId, i), img.toJPEG(QUALITY))
    })
    prune()
  } catch {
    // A thumbnail is a convenience. Never let it break sending a message.
  }
}

/** The thumbnail for one image of one message, or null if there isn't one. */
export function readThumbnail(messageId: string, index: number): StoredImage | null {
  try {
    const f = fileFor(messageId, index)
    if (!existsSync(f)) return null
    return { mediaType: 'image/jpeg', data: readFileSync(f).toString('base64') }
  } catch {
    return null
  }
}

/** Oldest first, once the folder grows past MAX_FILES. */
function prune(): void {
  try {
    const d = dir()
    const files = readdirSync(d)
    if (files.length <= MAX_FILES) return
    const withTime = files
      .map((f) => {
        const p = join(d, f)
        try {
          return { p, t: statSync(p).mtimeMs }
        } catch {
          return null
        }
      })
      .filter((x): x is { p: string; t: number } => !!x)
      .sort((a, b) => a.t - b.t)
    for (const { p } of withTime.slice(0, withTime.length - MAX_FILES)) {
      try {
        unlinkSync(p)
      } catch {
        // fine
      }
    }
  } catch {
    // fine
  }
}
