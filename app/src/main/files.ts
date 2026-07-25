import { ipcMain } from 'electron'
import { readdirSync, statSync } from 'fs'
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

export function listProjectFiles(root: string, max = 1000): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    if (out.length >= max) return
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
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(full)
      else out.push(relative(root, full))
    }
  }
  walk(root)
  return out.sort()
}

export function registerFilesIpc(): void {
  ipcMain.handle('files:list', (_e, root: string) => listProjectFiles(root))
}
