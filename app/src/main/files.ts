import { ipcMain, shell, nativeImage } from 'electron'
import { execFile } from 'child_process'
import {
  readdirSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  statSync,
  existsSync,
  cpSync,
  openSync,
  readSync,
  closeSync
} from 'fs'
import { join, relative, basename, extname } from 'path'

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

/**
 * Every path under a project, shallowest first, up to a budget.
 *
 * Breadth-first, which matters more than it sounds: depth-first spent the
 * whole budget inside the first big sub-repo it walked into and returned
 * before it had even finished listing the top level — a monorepo showed nine
 * of its twenty-one entries and simply omitted the rest, with nothing to say
 * so. Level by level, the top of the tree is always complete and it is the
 * deepest, least-looked-at corners that get cut.
 *
 * Directories are named in their own right (a trailing "/") rather than being
 * inferred from the files inside them, so a directory whose contents fell
 * outside the budget still appears — and can still be opened.
 */
export function listProjectFiles(root: string, max = 8000): string[] {
  const out: string[] = []
  let level: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }]
  while (level.length && out.length < max) {
    const next: { dir: string; depth: number }[] = []
    for (const { dir, depth } of level) {
      if (out.length >= max) break
      let entries: string[]
      try {
        entries = readdirSync(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (out.length >= max) break
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
        if (st.isDirectory()) {
          out.push(relative(root, full) + '/')
          if (depth + 1 <= MAX_DEPTH) next.push({ dir: full, depth: depth + 1 })
        } else if (st.isFile()) {
          out.push(relative(root, full))
        }
      }
    }
    level = next
  }
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

// Cap the in-app text viewer so a stray huge/binary file can't lock up the
// renderer. Bigger files fall back to opening in the OS.
const MAX_TEXT_BYTES = 2 * 1024 * 1024

export function registerFilesIpc(): void {
  // Background shells write their output to a file, and the Bash result says
  // where. Reading it directly means the strip can show what a job is doing
  // live, instead of waiting for the agent to poll it.
  ipcMain.handle('bg:tail', (_e, path: string, maxBytes = 8000) => {
    try {
      if (!path.endsWith('.output')) return null
      const { size } = statSync(path)
      const start = Math.max(0, size - maxBytes)
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(Math.min(size, maxBytes))
        readSync(fd, buf, 0, buf.length, start)
        return buf.toString('utf8')
      } finally {
        closeSync(fd)
      }
    } catch {
      return null
    }
  })

  ipcMain.handle('files:list', (_e, root: string) => listProjectFiles(root))
  // Finder drops onto the file tree: copy into the project (folders included),
  // renaming on collision rather than overwriting someone's work.
  // A chat's private git worktree under <project>/.worktrees/<slug>, on its own
  // branch — parallel chats stop fighting over one working tree.
  ipcMain.handle('worktree:create', (_e, projectPath: string) => {
    return new Promise((resolve) => {
      const slug = `wt-${Date.now().toString(36)}`
      const branch = `superagent/${slug}`
      const dir = join(projectPath, '.worktrees', slug)
      // Keep .worktrees out of git status without touching the project's .gitignore.
      try {
        const exclude = join(projectPath, '.git', 'info', 'exclude')
        if (existsSync(join(projectPath, '.git')) && existsSync(exclude)) {
          const cur = readFileSync(exclude, 'utf8')
          if (!cur.includes('.worktrees/')) writeFileSync(exclude, cur + '\n.worktrees/\n')
        }
      } catch {
        // exclusion is best-effort
      }
      execFile(
        'git',
        ['worktree', 'add', dir, '-b', branch],
        { cwd: projectPath },
        (err) => resolve(err ? null : { path: dir, branch })
      )
    })
  })
  ipcMain.handle('worktree:remove', (_e, projectPath: string, wtPath: string) => {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['worktree', 'remove', '--force', wtPath],
        { cwd: projectPath },
        (err) => resolve(!err)
      )
    })
  })

  ipcMain.handle('files:import', (_e, destDir: string, sources: string[]) => {
    const imported: string[] = []
    for (const src of sources) {
      try {
        const ext = extname(src)
        const stem = basename(src, ext)
        let target = join(destDir, basename(src))
        for (let n = 2; existsSync(target); n++) target = join(destDir, `${stem} ${n}${ext}`)
        cpSync(src, target, { recursive: true })
        imported.push(target)
      } catch (err) {
        console.error('[files] import failed:', src, err)
      }
    }
    return imported
  })
  // Fallback for types the in-app browser can't render (.docx, .xlsx, …).
  /**
   * A thumbnail for a desktop icon, as a data URI.
   *
   * The renderer is served over http in development, so it cannot load a
   * file:// image at all — main reads it instead, and downscales it here so a
   * desk full of screenshots costs a few KB rather than a few MB.
   */
  ipcMain.handle('files:thumb', (_e, path: string): string | null => {
    try {
      if (statSync(path).size > 40 * 1024 * 1024) return null
      const img = nativeImage.createFromPath(path)
      if (img.isEmpty()) return null
      const { width, height } = img.getSize()
      const side = 128
      const small = width >= height ? img.resize({ width: side }) : img.resize({ height: side })
      return small.toDataURL()
    } catch {
      return null
    }
  })

  ipcMain.handle('files:openExternal', (_e, path: string) => shell.openPath(path))
  ipcMain.handle('git:branch', (_e, cwd: string) => gitBranch(cwd))
  ipcMain.handle('git:subrepos', (_e, root: string) => gitSubrepos(root))
  // Read a text file for the in-app viewer/editor. Returns null if it's missing,
  // too large, or not decodable as UTF-8 text (so the caller can fall back to the OS).
  ipcMain.handle('files:read', (_e, path: string): string | null => {
    try {
      if (statSync(path).size > MAX_TEXT_BYTES) return null
      const buf = readFileSync(path)
      // A NUL byte in the first chunk is a reliable "this is binary" signal.
      if (buf.subarray(0, 8000).includes(0)) return null
      return buf.toString('utf8')
    } catch {
      return null
    }
  })
  // Save edits from the in-app editor. Returns true on success.
  ipcMain.handle('files:write', (_e, path: string, content: string): boolean => {
    try {
      writeFileSync(path, content, 'utf8')
      return true
    } catch {
      return false
    }
  })
}
