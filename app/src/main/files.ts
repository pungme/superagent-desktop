import { ipcMain, shell } from 'electron'
import { readdirSync, lstatSync, readFileSync } from 'fs'
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

/**
 * Current git branch of a project dir, or null if it isn't a git repo. Reads
 * .git/HEAD directly (fast, no spawn); handles worktrees/submodules (.git is a
 * file "gitdir: <path>") and detached HEAD (returns a short SHA).
 */
export function gitBranch(cwd: string): string | null {
  try {
    let gitDir = join(cwd, '.git')
    if (lstatSync(gitDir).isFile()) {
      const m = readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/)
      if (!m) return null
      gitDir = m[1].trim()
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/)
    return ref ? ref[1] : head.slice(0, 7)
  } catch {
    return null
  }
}

export interface SubRepo {
  name: string
  path: string
  branch: string | null
}

/**
 * Immediate child directories of `root` that are their own git repos — for a
 * folder that holds several repos (a monorepo-of-repos / workspace). Depth 1
 * only; skips heavy/hidden dirs and symlinks.
 */
export function gitSubrepos(root: string): SubRepo[] {
  try {
    const out: SubRepo[] = []
    for (const e of readdirSync(root, { withFileTypes: true })) {
      // isDirectory() is false for symlinks with withFileTypes, so symlinks are skipped.
      if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
      const path = join(root, e.name)
      try {
        lstatSync(join(path, '.git')) // throws if not a repo
      } catch {
        continue
      }
      out.push({ name: e.name, path, branch: gitBranch(path) })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function registerFilesIpc(): void {
  ipcMain.handle('files:list', (_e, root: string) => listProjectFiles(root))
  // Fallback for types the in-app browser can't render (.docx, .xlsx, …).
  ipcMain.handle('files:openExternal', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('git:branch', (_e, cwd: string) => gitBranch(cwd))
  ipcMain.handle('git:subrepos', (_e, root: string) => gitSubrepos(root))
}
