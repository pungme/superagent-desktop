import { execFile } from 'child_process'

/**
 * What git says about a session's worktree (branch, commits not in main, files changed), kept in a
 * cache and read in the background. The Conductor's list is asked for every few seconds by several
 * windows and views; with twenty sessions, asking git for each one on the main thread froze the
 * whole app for seconds at a time (measured: 1 to 5.5 s per list). Now the list answers at once
 * from the cache, and a read that finds something new tells the windows to look again.
 */
export interface GitFacts {
  branch?: string
  /** Commits on the branch that the main branch lacks. */
  unmerged?: number
  /** Files changed against the main branch, committed or not. */
  files?: string[]
}

const cache = new Map<string, { at: number; facts: GitFacts }>()
const inflight = new Map<string, Promise<GitFacts>>()
/** A fact this old is read again (in the background) the next time it is wanted. */
const DEFAULT_MAX_AGE = 8_000
/** No more than this many git processes at once, however many sessions there are. */
const MAX_PARALLEL = 4
let running = 0
const waiting: (() => void)[] = []
let onUpdate: (() => void) | null = null
let notifyTimer: ReturnType<typeof setTimeout> | null = null

/** Called (once the burst is over) when a read found a session that changed. */
export function setGitUpdateHandler(fn: (() => void) | null): void {
  onUpdate = fn
}

function notifySoon(): void {
  if (!onUpdate || notifyTimer) return
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    onUpdate?.()
  }, 200)
}

async function slot<T>(f: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((res) => waiting.push(res))
  running++
  try {
    return await f()
  } finally {
    running--
    waiting.shift()?.()
  }
}

function git(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024 },
      (err, out) => resolve(err ? null : out)
    )
  })
}

async function read(cwd: string): Promise<GitFacts> {
  const head = await git(cwd, ['status', '--porcelain=v2', '--branch'])
  if (head === null) return {}
  let branch: string | undefined
  const dirty: string[] = []
  for (const line of head.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const b = line.slice('# branch.head '.length).trim()
      branch = b && b !== '(detached)' ? b : undefined
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // "1 XY sub mH mI mW hH hI path" / "2 XY … path\torig"
      const parts = line.split(' ')
      const path = parts.slice(line.startsWith('2 ') ? 9 : 8).join(' ')
      dirty.push(path.split('\t')[0])
    } else if (line.startsWith('? ')) dirty.push(line.slice(2))
  }
  let base: string | null = null
  for (const b of ['main', 'master']) {
    if ((await git(cwd, ['rev-parse', '--verify', '--quiet', b])) !== null) {
      base = b
      break
    }
  }
  if (!base) return { branch }
  const [count, diff] = await Promise.all([
    git(cwd, ['rev-list', '--count', `${base}..HEAD`]),
    git(cwd, ['diff', '--name-only', `${base}...HEAD`])
  ])
  const committed = (diff ?? '').split('\n').filter(Boolean)
  return {
    branch,
    unmerged: count === null ? undefined : Number(count.trim()) || 0,
    files: [...new Set([...committed, ...dirty])].sort()
  }
}

const same = (a: GitFacts, b: GitFacts): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Read now (waiting for git), cache the answer, and say so if it differs from what was cached. */
export function freshGit(cwd: string): Promise<GitFacts> {
  const running = inflight.get(cwd)
  if (running) return running
  const p = slot(() => read(cwd))
    .then((facts) => {
      const before = cache.get(cwd)?.facts
      cache.set(cwd, { at: Date.now(), facts })
      if (!before || !same(before, facts)) notifySoon()
      return facts
    })
    .finally(() => inflight.delete(cwd))
  inflight.set(cwd, p)
  return p
}

/** What is known right now, at once. A missing or stale entry is read in the background. */
export function cachedGit(cwd: string | null, maxAge = DEFAULT_MAX_AGE): GitFacts {
  if (!cwd) return {}
  const hit = cache.get(cwd)
  if (!hit || Date.now() - hit.at > maxAge) void freshGit(cwd)
  return hit?.facts ?? {}
}

/** Forget what is cached (a session closed, or its folder went). */
export function forgetGit(cwd?: string): void {
  if (cwd) cache.delete(cwd)
  else cache.clear()
}
