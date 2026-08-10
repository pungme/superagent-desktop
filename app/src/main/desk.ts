import { ipcMain, app, shell } from 'electron'
import {
  mkdirSync,
  readdirSync,
  lstatSync,
  statSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  existsSync,
  realpathSync
} from 'fs'
import { join, basename, dirname, resolve, relative, isAbsolute } from 'path'

/**
 * The desktop, as a real folder.
 *
 * It used to be a list of paths in localStorage — a shelf of pointers to files
 * that lived elsewhere. That made a folder on it impossible to mean honestly:
 * there was nowhere to create one, and dragging something in could only be a
 * fiction or a file being moved out of somebody's project.
 *
 * So the desk is a directory. Things made here are really here, and Finder and
 * the agent can both open it. Things you point at from elsewhere appear as
 * symlinks — real entries that resolve to the original, so a README in a repo
 * can sit on the desk without leaving the repo, and dragging it into a folder
 * moves the link rather than the file.
 *
 * It lives inside the app's own space rather than ~/Desktop: this is
 * SuperAgent's desk, not the one macOS already owns.
 */

export function deskRoot(): string {
  const dir = join(app.getPath('userData'), 'Desktop')
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface DeskEntry {
  name: string
  /** Where the entry itself is — inside the desk. */
  path: string
  /** What it points at: itself, or the file it links to. */
  target: string
  dir: boolean
  link: boolean
}

/** Never let a path argument escape the desk, however it was constructed. */
function inDesk(p: string): boolean {
  const root = deskRoot()
  const rel = relative(root, resolve(p))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function listDesk(dir?: string): DeskEntry[] {
  const root = deskRoot()
  const at = dir && inDesk(dir) ? dir : root
  let names: string[]
  try {
    names = readdirSync(at)
  } catch {
    return []
  }
  const out: DeskEntry[] = []
  for (const name of names) {
    if (name.startsWith('.')) continue
    const path = join(at, name)
    try {
      const st = lstatSync(path)
      const link = st.isSymbolicLink()
      // A link to a folder is a folder, so it opens like one.
      const real = link ? realpathSync(path) : path
      const dirEntry = link ? existsSync(real) && statSync(real).isDirectory() : st.isDirectory()
      out.push({ name, path, target: real, dir: dirEntry, link })
    } catch {
      // A broken link — whatever it pointed at is gone. Skip it rather than
      // showing an icon that cannot open.
    }
  }
  return out.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)))
}

/** A name nothing else in this folder is using. */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let i = 2; i < 500; i++) {
    const next = `${stem} ${i}${ext}`
    if (!existsSync(join(dir, next))) return next
  }
  return `${stem} ${Date.now()}${ext}`
}

export function registerDeskIpc(): void {
  ipcMain.handle('desk:root', () => deskRoot())
  ipcMain.handle('desk:list', (_e, dir?: string) => listDesk(dir))

  ipcMain.handle('desk:newFolder', (_e, dir?: string, name = 'New folder') => {
    const at = dir && inDesk(dir) ? dir : deskRoot()
    const path = join(at, freeName(at, name))
    mkdirSync(path)
    return path
  })

  /**
   * Put something from elsewhere on the desk: a link, not a copy. The file
   * stays where it lives, and taking it off the desk later deletes only the
   * link.
   */
  ipcMain.handle('desk:link', (_e, target: string, dir?: string) => {
    const at = dir && inDesk(dir) ? dir : deskRoot()
    if (!existsSync(target)) return null
    // Already inside the desk: nothing to link, it is here.
    if (inDesk(target)) return target
    const path = join(at, freeName(at, basename(target)))
    symlinkSync(target, path)
    return path
  })

  /** Move an entry within the desk — into a folder, or back out of one. */
  ipcMain.handle('desk:move', (_e, from: string, toDir: string) => {
    if (!inDesk(from) || !inDesk(toDir)) return null
    if (dirname(from) === toDir) return from
    // A folder cannot be moved inside itself.
    if (resolve(toDir).startsWith(resolve(from) + '/')) return null
    const path = join(toDir, freeName(toDir, basename(from)))
    renameSync(from, path)
    return path
  })

  ipcMain.handle('desk:rename', (_e, path: string, name: string) => {
    if (!inDesk(path) || !name.trim() || name.includes('/')) return null
    const next = join(dirname(path), freeName(dirname(path), name.trim()))
    renameSync(path, next)
    return next
  })

  /**
   * Take something off the desk. A link is just unlinked — whatever it pointed
   * at is untouched. Anything that really lives here goes to the Trash rather
   * than being unlinked outright, so it is recoverable.
   */
  ipcMain.handle('desk:remove', async (_e, path: string) => {
    if (!inDesk(path)) return false
    try {
      if (lstatSync(path).isSymbolicLink()) unlinkSync(path)
      else await shell.trashItem(path)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('desk:reveal', (_e, path: string) => {
    if (inDesk(path) || existsSync(path)) shell.showItemInFolder(path)
  })
}
