import { nativeImage } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, FSWatcher, readFileSync, statSync, watch } from 'fs'
import os from 'os'
import { join } from 'path'
import { broadcastToWindows } from './util'

const run = promisify(execFile)

/**
 * A screenshot you just took, offered to the chat you're in.
 *
 * macOS saves one to a folder (Desktop unless changed in the Screenshot app);
 * we watch that folder and hand each new one to the windows, which show it
 * above the composer to attach or dismiss. Nothing is attached unasked.
 */

export interface NewScreenshot {
  path: string
  name: string
  mediaType: string
  /** base64, no data-URL prefix — the composer's own image shape. */
  data: string
  at: number
}

/** "Screenshot 2026-09-29 at 20.02.46.png", and the older "Screen Shot …". */
export function looksLikeScreenshot(name: string): boolean {
  return /^(screenshot|screen shot)\b.*\.(png|jpe?g|heic)$/i.test(name)
}

/** Where macOS puts screenshots: the Screenshot app's choice, else the Desktop. */
export async function screenshotDir(): Promise<string> {
  if (process.env.COVE_E2E_SCREENSHOT_DIR) return process.env.COVE_E2E_SCREENSHOT_DIR
  try {
    const { stdout } = await run('defaults', ['read', 'com.apple.screencapture', 'location'], {
      timeout: 5000
    })
    const dir = stdout.trim().replace(/^~(?=\/|$)/, os.homedir())
    if (dir && existsSync(dir)) return dir
  } catch {
    // not set: the default
  }
  return join(os.homedir(), 'Desktop')
}

/**
 * The picture, small enough to send: a Retina screenshot is often several
 * megabytes, and the model sees no more than about 2000px of it anyway.
 */
function load(path: string): { mediaType: string; data: string } | null {
  try {
    const img = nativeImage.createFromPath(path)
    // Something nativeImage cannot read (a HEIC on an older macOS): send the
    // file as it is rather than dropping it.
    if (img.isEmpty()) {
      const ext = path.split('.').pop()?.toLowerCase()
      const mediaType = ext === 'png' ? 'image/png' : ext === 'heic' ? 'image/heic' : 'image/jpeg'
      return { mediaType, data: readFileSync(path).toString('base64') }
    }
    const { width } = img.getSize()
    const out = width > 2000 ? img.resize({ width: 2000, quality: 'good' }) : img
    return { mediaType: 'image/png', data: out.toPNG().toString('base64') }
  } catch {
    return null
  }
}

let watcher: FSWatcher | null = null

export async function watchScreenshots(): Promise<void> {
  if (watcher) return
  const dir = await screenshotDir()
  if (!existsSync(dir)) return
  const startedAt = Date.now()
  const seen = new Set<string>()
  try {
    watcher = watch(dir, (_event, file) => {
      const name = file?.toString()
      if (!name || seen.has(name) || !looksLikeScreenshot(name)) return
      const path = join(dir, name)
      // macOS writes the file after its own floating thumbnail goes away, and
      // may still be writing it: wait for it to settle before reading.
      let lastSize = -1
      let tries = 0
      const check = (): void => {
        tries++
        let size = -1
        let born = 0
        try {
          const st = statSync(path)
          size = st.size
          born = st.birthtimeMs || st.mtimeMs
        } catch {
          // renamed away, or not there yet
        }
        // Only new ones: renaming or tidying old screenshots also fires here.
        if (size > 0 && born < startedAt - 1000) return
        if (size > 0 && size === lastSize) {
          if (seen.has(name)) return
          seen.add(name)
          const img = load(path)
          if (!img) return
          const shot: NewScreenshot = { path, name, ...img, at: Date.now() }
          broadcastToWindows('screenshots:new', shot)
          return
        }
        lastSize = size
        if (tries < 20) setTimeout(check, 300)
      }
      setTimeout(check, 200)
    })
  } catch {
    watcher = null
  }
}
