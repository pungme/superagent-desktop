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

/**
 * How far the branch is ahead of / behind its upstream — so the sidebar can say
 * "there's something to pull". Uses git's LOCAL tracking refs only (no network
 * fetch, which could hang or prompt for credentials on a private repo), so the
 * count is accurate as of the last fetch/pull. null when there's no upstream or
 * it isn't a repo.
 */
export function gitAheadBehind(cwd: string): Promise<{ ahead: number; behind: number } | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
      { cwd, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(null) // no upstream, detached, or not a repo
        const m = stdout.trim().match(/^(\d+)\s+(\d+)$/)
        // left = upstream-only (behind), right = HEAD-only (ahead).
        resolve(m ? { behind: Number(m[1]), ahead: Number(m[2]) } : null)
      }
    )
  })
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
  ipcMain.handle(
    'worktree:create',
    (_e, projectPath: string, opts?: { branch?: string; newBranch?: string; base?: string }) => {
      return new Promise((resolve) => {
        const slug = `wt-${Date.now().toString(36)}`
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
        // Three ways to say which branch the worktree is on:
        //  - opts.branch: check out an EXISTING branch (feature-1) in the worktree.
        //  - opts.newBranch: create a NEW branch, optionally from opts.base.
        //  - neither: the historical default — a fresh auto-named superagent/ branch.
        let args: string[]
        let branch: string
        if (opts?.branch) {
          branch = opts.branch
          args = ['worktree', 'add', dir, branch]
        } else if (opts?.newBranch) {
          branch = opts.newBranch
          args = ['worktree', 'add', dir, '-b', branch, ...(opts.base ? [opts.base] : [])]
        } else {
          branch = `superagent/${slug}`
          args = ['worktree', 'add', dir, '-b', branch]
        }
        execFile('git', args, { cwd: projectPath }, (err) =>
          resolve(err ? null : { path: dir, branch })
        )
      })
    }
  )
  // Local branches, with the current one flagged and any already checked out in a
  // worktree marked (git won't check the same branch out twice). Powers the
  // branch picker + the toolbar switcher.
  ipcMain.handle('git:branches', (_e, cwd: string) => {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['for-each-ref', '--format=%(refname:short)|%(HEAD)|%(worktreepath)', 'refs/heads/'],
        { cwd, maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err) return resolve([])
          const rows = stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              const [name, head, wt] = l.split('|')
              return { name, current: head === '*', worktree: wt ? wt.trim() || null : null }
            })
          resolve(rows)
        }
      )
    })
  })
  // Switch the checkout to another branch. Fails cleanly if the tree is dirty or
  // the branch is checked out in a worktree — git returns non-zero and we surface it.
  ipcMain.handle('git:checkout', (_e, cwd: string, branch: string) => {
    return new Promise((resolve) => {
      execFile('git', ['checkout', branch], { cwd }, (err, _stdout, stderr) =>
        resolve(err ? { ok: false, error: (stderr || '').trim() } : { ok: true })
      )
    })
  })
  ipcMain.handle('worktree:remove', (_e, projectPath: string, wtPath: string) => {
    return new Promise((resolve) => {
      execFile('git', ['worktree', 'remove', '--force', wtPath], { cwd: projectPath }, (err) =>
        resolve(!err)
      )
    })
  })

  // Fold a worktree chat's work back into the project and tidy up: commit
  // whatever the agent left in the worktree, squash it into ONE commit on the
  // project's current branch, then remove the worktree and delete its branch.
  // Every failure mode leaves the repo exactly as it was — a half-merged tree is
  // worse than no button.
  ipcMain.handle(
    'worktree:merge',
    async (_e, projectPath: string, wtPath: string, message: string) => {
      const git = (args: string[], cwd: string): Promise<{ code: number; out: string }> =>
        new Promise((resolve) =>
          execFile('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
            resolve({
              code: err ? ((err as { code?: number }).code ?? 1) : 0,
              out: (stdout || '') + (stderr || '')
            })
          )
        )
      type R =
        | { ok: true; committed: boolean }
        | {
            ok: false
            reason: 'not-worktree' | 'base-dirty' | 'nothing' | 'conflict' | 'error'
            detail?: string
          }

      // The branch checked out IN the worktree is what we merge.
      const head = await git(['rev-parse', '--abbrev-ref', 'HEAD'], wtPath)
      const branch = head.out.trim()
      if (head.code !== 0 || !branch || branch === 'HEAD') {
        return { ok: false, reason: 'not-worktree', detail: head.out.trim() } as R
      }

      // Commit anything the agent left uncommitted in the worktree, so the
      // squash actually captures it.
      const wtStatus = await git(['status', '--porcelain'], wtPath)
      if (wtStatus.out.trim()) {
        await git(['add', '-A'], wtPath)
        const c = await git(['commit', '-m', message || 'Worktree changes'], wtPath)
        if (c.code !== 0) return { ok: false, reason: 'error', detail: c.out.trim() } as R
      }

      // Refuse if the project's own working tree is dirty — a squash merge writes
      // into it, and mixing the user's in-progress edits with the merge is the
      // kind of surprise that loses work.
      const baseStatus = await git(['status', '--porcelain'], projectPath)
      if (baseStatus.out.trim()) {
        return { ok: false, reason: 'base-dirty' } as R
      }

      // Nothing to bring over (branch identical to base) → say so, don't make an
      // empty commit.
      const ahead = await git(['rev-list', '--count', `HEAD..${branch}`], projectPath)
      if (ahead.out.trim() === '0') {
        return { ok: false, reason: 'nothing' } as R
      }

      // The squash: stages the branch's net change onto the base without a merge
      // commit. On conflict, undo cleanly (base was verified clean above) and
      // leave everything — including the worktree — untouched to resolve by hand.
      const sq = await git(['merge', '--squash', branch], projectPath)
      if (sq.code !== 0) {
        await git(['reset', '--hard', 'HEAD'], projectPath)
        return { ok: false, reason: 'conflict', detail: sq.out.trim().slice(0, 300) } as R
      }
      const commit = await git(['commit', '-m', message || `Merge ${branch}`], projectPath)
      if (commit.code !== 0) {
        // Tell "empty squash, nothing to commit" apart from a real commit failure
        // (a failing pre-commit hook, GPG signing) that DID have changes staged —
        // otherwise a hook rejection reads as the misleading "nothing to merge".
        // `diff --cached --quiet` exits non-zero when there ARE staged changes.
        const hadStaged = (await git(['diff', '--cached', '--quiet'], projectPath)).code !== 0
        await git(['reset', '--hard', 'HEAD'], projectPath)
        return hadStaged
          ? ({ ok: false, reason: 'error', detail: commit.out.trim() } as R)
          : ({ ok: false, reason: 'nothing', detail: commit.out.trim() } as R)
      }

      // Merged — now tidy up. Best-effort: the merge already succeeded, so even
      // if cleanup hiccups the work is safe.
      await git(['worktree', 'remove', '--force', wtPath], projectPath)
      await git(['branch', '-D', branch], projectPath)
      return { ok: true, committed: true } as R
    }
  )

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
  ipcMain.handle('git:aheadBehind', (_e, cwd: string) => gitAheadBehind(cwd))
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
