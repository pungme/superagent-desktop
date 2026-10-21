import { app, ipcMain, nativeImage, shell } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import {
  appendFileSync,
  existsSync,
  FSWatcher,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  watch
} from 'fs'
import os from 'os'
import { basename, join } from 'path'
import { broadcastToWindows } from './util'
import { healthLog } from './health'

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

/**
 * "Attach & delete": the picture is in the message now, so the file on the
 * Desktop is clutter. To the Trash, not gone — and only ever a screenshot in
 * the screenshot folder, whatever name the window sends.
 */
export async function trashScreenshots(
  names: string[]
): Promise<{ name: string; error: string }[]> {
  const dir = await screenshotDir()
  const failed: { name: string; error: string }[] = []
  for (const raw of names) {
    const name = basename(String(raw))
    if (!looksLikeScreenshot(name)) continue
    const path = join(dir, name)
    if (!existsSync(path)) continue // already moved or deleted: nothing left to tidy
    // The e2e folder is a temp one: nothing of the user's Trash to fill.
    if (process.env.COVE_E2E_SCREENSHOT_DIR) {
      rmSync(path, { force: true })
      continue
    }
    let error = ''
    try {
      await shell.trashItem(path)
    } catch (err) {
      error = String((err as Error)?.message ?? err)
    }
    // It said yes and the file is still there, or it said no: move it into the
    // Trash folder ourselves. Swallowing this is what left screenshots on the
    // Desktop with nobody able to say why.
    if (existsSync(path)) {
      try {
        const trash = join(os.homedir(), '.Trash')
        let target = join(trash, name)
        for (let n = 2; existsSync(target); n++)
          target = join(trash, name.replace(/(\.\w+)$/, ` ${n}$1`))
        renameSync(path, target)
      } catch (err) {
        error = `${error ? `${error}; ` : ''}${String((err as Error)?.message ?? err)}`
      }
    }
    if (existsSync(path)) {
      failed.push({ name, error: error || 'it is still there' })
      logShot(`could not trash ${path}: ${error || 'still there after trashItem'}`)
    }
  }
  return failed
}

/** Why a screenshot stayed put, kept where it can be read afterwards. */
function logShot(line: string): void {
  try {
    appendFileSync(
      join(app.getPath('userData'), 'screenshots.log'),
      `${new Date().toISOString()} ${line}\n`
    )
  } catch {
    // nowhere to write: the window still hears of it
  }
}

let watcher: FSWatcher | null = null
let retry: ReturnType<typeof setTimeout> | null = null

/**
 * Start watching; say where, and say why not. The Desktop is a folder macOS
 * guards: a watch refused at launch (permission not yet given, or taken away
 * by an update) used to fail without a word and stay failed for the whole
 * session — "the screenshot feature stopped working", 2026-10-21. Now a
 * failure is logged and tried again every minute until it works.
 */
export async function watchScreenshots(): Promise<void> {
  if (watcher) return
  ipcMain.removeHandler('screenshots:trash')
  ipcMain.handle('screenshots:trash', (_e, names: string[]) => trashScreenshots(names))
  const dir = await screenshotDir()
  const again = (why: string): void => {
    logShot(`not watching ${dir}: ${why} — trying again in 60s`)
    healthLog(`screenshots: not watching ${dir}: ${why}`)
    if (retry) clearTimeout(retry)
    retry = setTimeout(() => {
      retry = null
      void watchScreenshots()
    }, 60_000)
  }
  if (!existsSync(dir)) return again('folder does not exist')
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
      let lastErr = ''
      const check = (): void => {
        tries++
        let size = -1
        let born = 0
        try {
          const st = statSync(path)
          size = st.size
          born = st.birthtimeMs || st.mtimeMs
        } catch (err) {
          // renamed away, not there yet — or not ours to read.
          lastErr = String((err as NodeJS.ErrnoException)?.code ?? err)
        }
        // Only new ones: renaming or tidying old screenshots also fires here.
        if (size > 0 && born < startedAt - 1000) return
        if (size > 0 && size === lastSize) {
          if (seen.has(name)) return
          seen.add(name)
          const img = load(path)
          if (!img) {
            logShot(`could not read ${path}`)
            healthLog(`screenshots: could not read ${name}`)
            return
          }
          const shot: NewScreenshot = { path, name, ...img, at: Date.now() }
          broadcastToWindows('screenshots:new', shot)
          return
        }
        lastSize = size
        if (tries < 20) setTimeout(check, 300)
        else {
          const denied = lastErr === 'EPERM' || lastErr === 'EACCES'
          const why = denied
            ? 'macOS is not letting Superagent read the Desktop (System Settings → Privacy & Security → Files and Folders)'
            : `never settled (${lastErr || 'size ' + size})`
          logShot(`gave up on ${path}: ${why}`)
          healthLog(`screenshots: gave up on ${name}: ${why}`)
        }
      }
      setTimeout(check, 200)
    })
    watcher.on('error', (err) => {
      watcher?.close()
      watcher = null
      again(`watch error: ${String((err as Error)?.message ?? err)}`)
    })
    logShot(`watching ${dir}`)
    healthLog(`screenshots: watching ${dir}`)
  } catch (err) {
    watcher = null
    again(String((err as Error)?.message ?? err))
  }
}
