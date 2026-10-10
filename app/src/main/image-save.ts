import { app, ipcMain, net, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'fs'
import { basename, extname, join } from 'path'
import { IMAGE_EXTS, localImagePath } from './files'
import { dataUrlParts, freeName, stampedName } from '../shared/chat-images'

/**
 * Saving a picture from a conversation to the Downloads folder, the way a
 * messaging app does. It only ever writes a picture, only into that folder,
 * and never over a file that is already there.
 */

export interface SaveImageRequest {
  /** What is on screen: a data: URL, or a web address. */
  src: string
  /** The file it came from, when the agent named one: the original is copied, not the preview. */
  origin?: string
  /** What `origin` is relative to. */
  base?: string
}
export type SaveImageResult =
  { ok: true; path: string; name: string } | { ok: false; error: string }

const MAX_BYTES = 60_000_000

/** A test run saves beside its own data, never into the real Downloads. */
function downloadsDir(): string {
  const dir = process.env.COVE_USER_DATA
    ? join(process.env.COVE_USER_DATA, 'downloads')
    : app.getPath('downloads')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function saveImage(req: SaveImageRequest): Promise<SaveImageResult> {
  try {
    const dir = downloadsDir()
    const free = (wanted: string): string => join(dir, freeName(readdirSync(dir), wanted))

    // A file the agent pointed at: the original, under its own name.
    const from = req.origin ? localImagePath(req.origin, req.base) : null
    if (from && existsSync(from) && IMAGE_EXTS.has(extname(from).toLowerCase())) {
      if (statSync(from).size > MAX_BYTES) return { ok: false, error: 'That picture is too large.' }
      const to = free(basename(from))
      copyFileSync(from, to)
      return { ok: true, path: to, name: basename(to) }
    }

    const data = dataUrlParts(req.src)
    if (data) {
      const bytes = Buffer.from(data.base64, 'base64')
      if (bytes.length > MAX_BYTES) return { ok: false, error: 'That picture is too large.' }
      const to = free(stampedName(data.ext))
      writeFileSync(to, bytes)
      return { ok: true, path: to, name: basename(to) }
    }

    if (/^https?:\/\//i.test(req.src)) {
      const res = await net.fetch(req.src)
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
      if (!res.ok || !type.startsWith('image/'))
        return { ok: false, error: 'That address did not return a picture.' }
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > MAX_BYTES) return { ok: false, error: 'That picture is too large.' }
      const named = basename(new URL(req.src).pathname)
      const wanted = IMAGE_EXTS.has(extname(named).toLowerCase())
        ? named
        : stampedName(type.slice(6).replace('jpeg', 'jpg').replace(/\W.*/, '') || 'png')
      const to = free(wanted)
      writeFileSync(to, bytes)
      return { ok: true, path: to, name: basename(to) }
    }
    return { ok: false, error: 'That picture could not be saved.' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'That picture could not be saved.' }
  }
}

export function registerImageSaveIpc(): void {
  ipcMain.handle('image:save', (_e, req: SaveImageRequest) =>
    saveImage({
      src: String(req?.src ?? ''),
      origin: req?.origin ? String(req.origin) : undefined,
      base: req?.base ? String(req.base) : undefined
    })
  )
  // Only something this just saved: a path inside the folder it saves into.
  ipcMain.on('image:reveal', (_e, path: string) => {
    const p = String(path)
    if (p.startsWith(downloadsDir() + '/') && existsSync(p)) shell.showItemInFolder(p)
  })
}
