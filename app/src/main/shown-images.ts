import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * A copy of each picture an agent showed from a file, so the reply still has
 * it after the file is gone.
 *
 * A reply holds only the path. Agents like to draw mockups and take
 * screenshots into /tmp, which macOS empties on restart, so a conversation
 * that showed two mockups yesterday showed two file names today. The first
 * time a picture is shown, a copy at the size it was shown at is kept here,
 * and used when the file has gone.
 */

/** The longest side kept: what the chat asks for when a picture is enlarged. */
export const KEPT_WIDTH = 1600
const MAX_FILES = 2000

let root = ''
/** Set once by main, from app.getPath('userData'); tests use a temporary folder. */
export function setShownImagesRoot(userData: string): void {
  root = join(userData, 'attachments', 'shown')
}

function fileFor(path: string): string | null {
  if (!root) return null
  return join(root, `${createHash('sha1').update(path).digest('hex')}.jpg`)
}

/**
 * Keep `jpeg` as the copy of `path`, unless the copy is already newer than the
 * file: a chat re-renders its pictures often, and rewriting each copy every
 * time would be disk writes for nothing.
 */
export function keepShownImage(path: string, fileMtimeMs: number, jpeg: () => Buffer): void {
  const f = fileFor(path)
  if (!f) return
  try {
    if (existsSync(f) && statSync(f).mtimeMs >= fileMtimeMs) return
    mkdirSync(root, { recursive: true })
    writeFileSync(f, jpeg())
    prune()
  } catch {
    // A copy is a convenience. Never let it stop the picture being shown.
  }
}

/** The kept copy of `path`, when the file itself can no longer be read. */
export function keptShownImage(path: string): string | null {
  const f = fileFor(path)
  return f && existsSync(f) ? f : null
}

function prune(): void {
  const files = readdirSync(root)
  if (files.length <= MAX_FILES) return
  const aged = files
    .map((n) => {
      const p = join(root, n)
      try {
        return { p, t: statSync(p).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { p: string; t: number } => !!x)
    .sort((a, b) => a.t - b.t)
  for (const { p } of aged.slice(0, aged.length - MAX_FILES)) {
    try {
      unlinkSync(p)
    } catch {
      // fine
    }
  }
}
