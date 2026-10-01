import { existsSync, lstatSync, readdirSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'

/**
 * A chat's copy of a folder of repos, as paths.
 *
 * A project that is one repo gives each chat a worktree of it, at
 * <project>/.worktrees/<slug>. A project that is a FOLDER of repos cannot — the
 * folder is not a repo, there is nothing to cut — so its chats used to share the
 * one checkout of every repo in it. Now such a chat gets the folder over again:
 *
 *   <project>/.worktrees/<slug>/
 *     api/        a worktree of <project>/api, on the chat's branch
 *     web/        a worktree of <project>/web, on the same branch
 *     notes.md -> a link to <project>/notes.md, which belongs to no repo
 *
 * The same shape as the project, so `../api` from inside `web` still resolves,
 * and one branch name across all of them. This file only reads that layout; the
 * git that makes and unmakes it is in chat-copy.ts. Kept apart, and free of
 * Electron and the store, so the agent's command line can ask about it too.
 */

/** Never linked into a copy, never counted as something a chat made. */
const IGNORED = new Set(['.worktrees', '.DS_Store', '.git'])

/**
 * Whether this path is a copy of a folder of repos, rather than a worktree of
 * one. Asked before anything is removed, so it is answered narrowly: directly
 * inside a `.worktrees`, in a project that is not itself a repo (what is in a
 * repo's .worktrees are its worktrees, whatever state they are in), and with no
 * `.git` of its own — a worktree has one; the folder holding several does not.
 */
export function isRepoSet(path: string): boolean {
  if (basename(dirname(path)) !== '.worktrees') return false
  if (existsSync(join(repoSetRoot(path), '.git'))) return false
  return !existsSync(join(path, '.git'))
}

/** The project a copy belongs to: <project>/.worktrees/<slug> → <project>. */
export function repoSetRoot(setPath: string): string {
  return dirname(dirname(setPath))
}

export interface SetMember {
  /** The repo's folder name, the same in the project and in the copy. */
  name: string
  /** The chat's worktree of it. */
  path: string
  /** The repo it is a worktree of — the original, in the project folder. */
  repo: string
}

/**
 * Whether a folder in a copy is the chat's worktree of the project's repo of
 * the same name. A worktree's `.git` is a FILE pointing back at its repo; a
 * repo the agent cloned or started here has a `.git` folder and no original
 * to be kept onto, and is just something the chat made.
 */
function isMember(setPath: string, name: string): boolean {
  try {
    return (
      lstatSync(join(setPath, name)).isDirectory() &&
      lstatSync(join(setPath, name, '.git')).isFile() &&
      existsSync(join(repoSetRoot(setPath), name, '.git'))
    )
  } catch {
    return false
  }
}

/** The worktrees in a copy. A linked repo (one git could not cut) is not one. */
export function setMembers(setPath: string): SetMember[] {
  const root = repoSetRoot(setPath)
  try {
    return readdirSync(setPath, { withFileTypes: true })
      .filter((e) => isMember(setPath, e.name))
      .map((e) => ({ name: e.name, path: join(setPath, e.name), repo: join(root, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

/**
 * What a chat left in its copy that belongs to no repo: a file or folder it
 * wrote at the top, beside the repos. Not a worktree, so no branch holds it, and
 * not a link, so it exists nowhere else — removing the copy would delete it.
 */
export function looseEntries(setPath: string): string[] {
  try {
    return readdirSync(setPath)
      .filter((name) => {
        if (IGNORED.has(name)) return false
        if (lstatSync(join(setPath, name)).isSymbolicLink()) return false
        return !isMember(setPath, name)
      })
      .sort()
  } catch {
    return []
  }
}

/**
 * What to link into a copy from the project: everything the worktrees did not
 * already put there. CLAUDE.md is left out — Claude Code reads every CLAUDE.md
 * from the working directory upward, and the project folder is two levels up,
 * so a link would have it read twice.
 */
export function entriesToLink(root: string, setPath: string): string[] {
  try {
    return readdirSync(root).filter(
      (name) =>
        !IGNORED.has(name) &&
        name !== 'CLAUDE.md' &&
        name !== 'CLAUDE.local.md' &&
        !lexists(join(setPath, name))
    )
  } catch {
    return []
  }
}

/** existsSync follows links, so a dangling one reads as absent. This does not. */
function lexists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Where Claude Code keeps the PROJECT's memory, for an agent started in a copy.
 *
 * Memory is filed under the working directory. A worktree of a repo is traced
 * back to its repo, so those chats share the project's memory already; a copy
 * of a folder of repos is just a folder, so each chat got an empty memory of
 * its own that was deleted with the copy — everything it had been told to
 * remember, gone, and nothing the project knew available to it. Null when the
 * path is not such a copy, or the name cannot be worked out.
 */
export function projectMemoryDir(cwd: string | undefined): string | null {
  if (!cwd || !isRepoSet(cwd)) return null
  try {
    // The same spelling Claude Code derives: the resolved path, with everything
    // that is not a letter or digit turned into a dash. Long paths get a hash
    // appended that is not worth guessing at.
    const name = realpathSync(repoSetRoot(cwd)).replace(/[^a-zA-Z0-9]/g, '-')
    if (name.length > 200) return null
    const config = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
    return join(config, 'projects', name, 'memory')
  } catch {
    return null
  }
}

/** What the agent is told about the copy it is working in. */
export function describeRepoSet(cwd: string | undefined): { root: string; repos: string[] } | null {
  if (!cwd || !isRepoSet(cwd)) return null
  const repos = setMembers(cwd).map((m) => m.name)
  return repos.length ? { root: repoSetRoot(cwd), repos } : null
}
