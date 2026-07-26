import { ipcMain } from 'electron'
import { readdirSync, lstatSync } from 'fs'
import { join, relative } from 'path'

/** Lists project files for @-mention autocomplete, skipping heavy/generated dirs. */

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.next',
  'build',
  '.cache',
  'coverage',
  '.turbo',
  'target',
  '.venv',
  'venv'
])

const MAX_DEPTH = 12

export function listProjectFiles(root: string, max = 1000): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (out.length >= max || depth > MAX_DEPTH) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= max) return
      if (SKIP_DIRS.has(entry)) continue
      const full = join(dir, entry)
      let st: ReturnType<typeof lstatSync>
      try {
        // lstat (not stat) so we can see symlinks without following them — never
        // descend into a symlinked dir, which is how directory cycles would recurse
        // forever.
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(full, depth + 1)
      else if (st.isFile()) out.push(relative(root, full))
    }
  }
  walk(root, 0)
  return out.sort()
}

export function registerFilesIpc(): void {
  ipcMain.handle('files:list', (_e, root: string) => listProjectFiles(root))
}
