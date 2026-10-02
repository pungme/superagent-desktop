import { ipcMain } from 'electron'
import { execFile } from 'child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync
} from 'fs'
import { basename, dirname, extname, join } from 'path'
import {
  branchSlugFromMessage,
  createWorktree,
  gitBranch,
  gitSubrepos,
  isAutoNamed,
  mergeWorktree,
  readWorktreeBase,
  removeWorktree,
  renameWorktreeBranch,
  worktreeStatus,
  type MergeResult,
  type SubRepo
} from './files'
import {
  entriesToLink,
  isRepoSet,
  linkedRepos,
  looseEntries,
  readSetMeta,
  repoSetRoot,
  setMembers,
  setMetaPath,
  writeSetMeta,
  type SetMember
} from './repo-set'
import { getChat, setChatCwd, takePendingBranch } from './store'
import { broadcastToWindows } from './util'

/**
 * A chat's own copy of its project: making it, asking what is in it, keeping
 * it and throwing it away.
 *
 * One repo, one worktree — that half is in files.ts and is unchanged. This is
 * the rule above it, which also covers a project that is a folder of repos (see
 * repo-set.ts for the layout): there the copy links to every repo and holds a
 * worktree of each one the chat has CHANGED, cut when the change is about to
 * happen (cutRepo). Each thing a chat can do to its copy is done to all of its
 * worktrees. Every caller — the window, the phone — comes through here, so
 * neither has to know which kind of project it is looking at.
 */

/**
 * More repos than this and a new chat works in the folder itself, as it always
 * did: someone's whole ~/code added as one project is not a product split
 * across repos, and its chats are not working on "the project".
 */
export const MAX_SET_REPOS = 30

export type CopyKind = 'repo' | 'repos'

/** The repos of a folder that a chat can be given a worktree of. */
function cuttableRepos(root: string): SubRepo[] {
  return gitSubrepos(root).filter((r) => !r.cloning && r.branch !== null)
}

/**
 * What a new chat in this project gets a copy of: the project when it is a
 * repo, each repo in it when it is a folder of them, nothing otherwise.
 */
export function copyKind(projectPath: string): CopyKind | null {
  if (gitBranch(projectPath) !== null) return 'repo'
  const n = cuttableRepos(projectPath).length
  return n > 0 && n <= MAX_SET_REPOS ? 'repos' : null
}

const git = (args: string[], cwd: string): Promise<{ code: number; out: string }> =>
  new Promise((resolve) =>
    execFile('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({
        code: err ? ((err as { code?: number }).code ?? 1) : 0,
        out: (stdout || '') + (stderr || '')
      })
    )
  )

const branchExists = async (repo: string, name: string): Promise<boolean> =>
  (await git(['show-ref', '--verify', '--quiet', `refs/heads/${name}`], repo)).code === 0

/**
 * A branch name no repo here has yet: the one asked for, or it with -2, -3…
 * Two chats that open with the same words want the same name, and git refusing
 * the second used to leave that chat working in the project folder. `own` is
 * the branch a repo's copy is already on, which is not a clash with itself.
 */
export async function freeBranchName(
  repos: { repo: string; own?: string }[],
  name: string,
  /** Names spoken for without being branches yet: see reservedBranches. */
  reserved?: Set<string>
): Promise<string> {
  for (let n = 1; n <= 20; n++) {
    const candidate = n === 1 ? name : `${name}-${n}`
    if (reserved?.has(candidate)) continue
    const taken = await Promise.all(
      repos.map(async (r) => r.own !== candidate && (await branchExists(r.repo, candidate)))
    )
    if (!taken.some(Boolean)) return candidate
  }
  return `${name}-${Date.now().toString(36)}`
}

/**
 * The branch names the project's other copies have put by. A copy that has cut
 * no repo yet holds its name only on paper, and a second chat opening with the
 * same words must not be handed the same one.
 */
function reservedBranches(root: string, except?: string): Set<string> {
  const out = new Set<string>()
  try {
    for (const name of readdirSync(join(root, '.worktrees'))) {
      const path = join(root, '.worktrees', name)
      if (path === except || name.endsWith('.json')) continue
      const meta = readSetMeta(path)
      if (meta) out.add(meta.branch)
    }
  } catch {
    // no copies yet
  }
  return out
}

/**
 * Give a chat the folder of repos over again — as links. Nothing is cut here:
 * the copy is a folder that points at everything in the project, and remembers
 * the branch its worktrees will be on. A repo is cut when the chat is about to
 * change it (cutRepo), so a chat that reads nineteen repos and changes one
 * leaves one worktree and one branch behind, and one that changes nothing
 * leaves none. Null when the folder has no repo a chat could be given.
 */
export async function createWorktreeSet(
  root: string,
  opts?: { newBranch?: string; autoName?: boolean }
): Promise<{ path: string; branch: string; base: string | null } | null> {
  const all = cuttableRepos(root)
  if (all.length === 0 || all.length > MAX_SET_REPOS) return null
  const slug = `wt-${Date.now().toString(36)}`
  const dir = join(root, '.worktrees', slug)
  // Free in every repo now, so the one name can serve whichever is cut later.
  const branch = await freeBranchName(
    all.map((r) => ({ repo: r.path })),
    opts?.newBranch ?? slug,
    reservedBranches(root)
  )
  mkdirSync(dir, { recursive: true })
  writeSetMeta(dir, { branch, autoName: opts?.autoName ?? !opts?.newBranch })
  // A link is the original, so nothing is isolated yet — and nothing needs to
  // be: reading is all a chat has done to a repo it has no worktree of.
  for (const name of entriesToLink(root, dir)) {
    try {
      symlinkSync(join(root, name), join(dir, name))
    } catch (err) {
      console.log(`[worktree] could not link ${name} into ${dir}:`, err)
    }
  }
  return { path: dir, branch, base: null }
}

/** The branch a copy's worktrees are on: what its repos are on already, or
 *  what it was told to use, or — a copy from before it was told — its own name. */
export function setBranch(setPath: string): { branch: string; autoName: boolean } {
  const meta = readSetMeta(setPath)
  const first = setMembers(setPath)[0]
  const live = first ? gitBranch(first.path) : null
  return {
    branch: live ?? meta?.branch ?? basename(setPath),
    autoName: meta?.autoName ?? (first ? isAutoNamed(first.path, live ?? '') : true)
  }
}

export type CutResult =
  | { ok: true; path: string; branch: string; fresh: boolean }
  | { ok: false; reason: 'not-a-copy' | 'not-a-repo' | 'error'; detail?: string }

/** One cut at a time per copy: two tools reaching for the same repo in the same
 *  breath must not both take the link away. */
const cutting = new Map<string, Promise<unknown>>()

/**
 * Give a chat its own worktree of ONE repo in its copy, in place of the link:
 * the same path, now on the chat's branch. Called when a change to that repo is
 * about to happen — by the hook that sees a file edit coming, and by the tool
 * an agent calls before a command that writes. Asking again is free.
 */
export function cutRepo(setPath: string, name: string): Promise<CutResult> {
  const next = (cutting.get(setPath) ?? Promise.resolve()).then(() => cutRepoNow(setPath, name))
  const settled = next.catch(() => undefined)
  cutting.set(setPath, settled)
  void settled.then(() => {
    if (cutting.get(setPath) === settled) cutting.delete(setPath)
  })
  return next
}

async function cutRepoNow(setPath: string, name: string): Promise<CutResult> {
  if (!isRepoSet(setPath) || !existsSync(setPath)) return { ok: false, reason: 'not-a-copy' }
  const at = join(setPath, name)
  const done = setMembers(setPath).find((m) => m.name === name)
  if (done) return { ok: true, path: done.path, branch: gitBranch(done.path) ?? '', fresh: false }
  if (!linkedRepos(setPath).includes(name)) return { ok: false, reason: 'not-a-repo' }
  const repo = join(repoSetRoot(setPath), name)
  if ((await git(['rev-parse', '--verify', '--quiet', 'HEAD'], repo)).code !== 0) {
    return {
      ok: false,
      reason: 'error',
      detail: 'it has no commits yet, so there is nothing to branch from.'
    }
  }
  const want = setBranch(setPath)
  // Free when the copy was made; someone may have taken the name in this repo since.
  const branch = await freeBranchName([{ repo }], want.branch)
  unlinkSync(at)
  const made = await createWorktree(repo, { newBranch: branch, autoName: want.autoName, dir: at })
  if (!made) {
    // Put the link back: a copy missing a repo is worse than one that shares it.
    try {
      if (!existsSync(at)) symlinkSync(repo, at)
    } catch {
      // nothing more to try
    }
    return { ok: false, reason: 'error', detail: 'git could not make a worktree of it.' }
  }
  // The repo's project now has a branch row, and this chat a repo chip.
  broadcastToWindows('projects:changed', {})
  return { ok: true, path: made.path, branch: made.branch, fresh: true }
}

/**
 * Put back as links the repos a copy has a worktree of but never changed: no
 * commit of its own, nothing unsaved. A copy made before repos were cut on
 * demand has a worktree of every repo in the project; this is what takes the
 * eighteen it did not need away again. A repo with anything in it is left.
 */
export async function shrinkCopy(setPath: string): Promise<{ linked: string[]; kept: string[] }> {
  const linked: string[] = []
  const kept: string[] = []
  if (!isRepoSet(setPath)) return { linked, kept }
  const members = setMembers(setPath)
  if (members.length === 0) return { linked, kept }
  // Before the first one goes: a copy with no worktree left has only this to
  // say which branch the next one belongs on.
  if (!readSetMeta(setPath)) writeSetMeta(setPath, setBranch(setPath))
  for (const m of members) {
    const status = await git(['status', '--porcelain'], m.path)
    const base = (await readWorktreeBase(m.path)) ?? gitBranch(m.repo)
    const ahead = base ? await git(['rev-list', '--count', `${base}..HEAD`], m.path) : null
    // Untouched only when git says so outright; anything unclear is kept.
    const untouched =
      status.code === 0 &&
      status.out.trim() === '' &&
      ahead !== null &&
      ahead.code === 0 &&
      ahead.out.trim() === '0'
    if (!untouched || !(await removeWorktree(m.repo, m.path)) || existsSync(m.path)) {
      kept.push(m.name)
      continue
    }
    try {
      symlinkSync(m.repo, m.path)
      linked.push(m.name)
    } catch (err) {
      console.log(`[worktree] could not link ${m.name} back into ${setPath}:`, err)
    }
  }
  if (linked.length) broadcastToWindows('projects:changed', {})
  return { linked, kept }
}

/**
 * Take a copy's folder away once its worktrees are gone. Guarded, because this
 * is the one place the app deletes a folder outright: only ever a folder
 * directly inside a `.worktrees`, and never through a link.
 */
function removeSetDir(setPath: string): void {
  try {
    if (basename(dirname(setPath)) !== '.worktrees') return
    if (!lstatSync(setPath).isDirectory()) return
    // Links are unlinked, not followed: what they point at is the project's.
    rmSync(setPath, { recursive: true, force: true })
    rmSync(setMetaPath(setPath), { force: true })
    // The last copy gone: leave the project folder as it was found.
    const holder = dirname(setPath)
    if (readdirSync(holder).filter((n) => n !== '.DS_Store').length === 0) {
      rmSync(holder, { recursive: true, force: true })
    }
  } catch {
    // already gone, or not ours to remove
  }
}

/**
 * Give a chat its own copy of the project, on the first message and named from
 * it. Returns the directory to work in.
 *
 * This is the rule that keeps two agents out of one checkout, so it lives here
 * rather than in a client: the window had its own copy and the phone had none,
 * which meant a chat started on the phone ran in the project folder beside
 * whatever else was already there.
 *
 * Nothing happens when the project is neither a repo nor a folder of them, or
 * when git refuses — the folder itself is a working answer, and losing the
 * message would not be.
 */
export async function ensureChatBranch(projectPath: string, hint: string): Promise<string | null> {
  const kind = copyKind(projectPath)
  if (!kind) return null
  const name = branchSlugFromMessage(hint)
  if (kind === 'repos') {
    const set = await createWorktreeSet(
      projectPath,
      name ? { newBranch: name, autoName: true } : undefined
    )
    return set?.path ?? null
  }
  const wt = await createWorktree(
    projectPath,
    name
      ? { newBranch: await freeBranchName([{ repo: projectPath }], name), autoName: true }
      : undefined
  )
  return wt?.path ?? null
}

/**
 * Cut a chat's branch and file it under the chat. Cutting takes a moment, and a
 * chat deleted in that moment had no branch yet for the delete to remove — so
 * the new one was left behind, a branch row with no conversation that came back
 * a second after the delete. If the chat is gone by the time its branch exists,
 * throw the branch away too.
 */
export async function cutChatBranch(
  chatId: string,
  projectPath: string,
  hint: string
): Promise<string | null> {
  const cwd = await ensureChatBranch(projectPath, hint)
  if (!cwd) return null
  if (!getChat(chatId)) {
    await removeCopy(projectPath, cwd)
    // The sidebar may have listed it in between; have it ask git again.
    broadcastToWindows('projects:changed', {})
    return null
  }
  setChatCwd(chatId, cwd)
  return cwd
}

/**
 * Remove a chat's copy of the project, and the branch it was on — in every
 * repo, when it has several. Exported because the phone deletes chats too.
 */
export async function removeCopy(projectPath: string, wtPath: string): Promise<boolean> {
  if (!isRepoSet(wtPath)) return removeWorktree(projectPath, wtPath)
  const results = await Promise.all(setMembers(wtPath).map((m) => removeWorktree(m.repo, m.path)))
  removeSetDir(wtPath)
  return results.every(Boolean)
}

export interface CopyStatus {
  dirty: boolean
  ahead: number
  /** The repos with something unkept, for a copy of several. */
  repos?: string[]
}

/** Whether a chat's copy holds anything the user has not kept. */
export async function copyStatus(projectPath: string, wtPath: string): Promise<CopyStatus> {
  if (!isRepoSet(wtPath)) return worktreeStatus(projectPath, wtPath)
  const members = setMembers(wtPath)
  const each = await Promise.all(members.map((m) => worktreeStatus(m.repo, m.path)))
  const repos = members.filter((_, i) => each[i].dirty || each[i].ahead > 0).map((m) => m.name)
  return {
    // A file written beside the repos is in no branch, but it is still
    // something the chat made that removing the copy would delete.
    dirty: each.some((s) => s.dirty) || looseEntries(wtPath).length > 0,
    ahead: each.reduce((n, s) => n + s.ahead, 0),
    repos
  }
}

export type CopyMergeResult =
  | { ok: true; committed: boolean; repos?: string[] }
  | {
      ok: false
      reason: 'not-worktree' | 'base-dirty' | 'nothing' | 'conflict' | 'error'
      detail?: string
      /** The repo that refused, for a copy of several. */
      repo?: string
      /** Repos whose changes had already landed when a later one failed. */
      kept?: string[]
    }

/** Put what a chat wrote beside the repos back beside the real ones. */
function moveLooseHome(setPath: string): void {
  const root = repoSetRoot(setPath)
  for (const name of looseEntries(setPath)) {
    try {
      const ext = extname(name)
      const stem = basename(name, ext)
      let target = join(root, name)
      // Never over something already there: the project's copy may be newer.
      for (let n = 2; existsSync(target); n++) target = join(root, `${stem} ${n}${ext}`)
      renameSync(join(setPath, name), target)
    } catch (err) {
      console.log(`[worktree] could not move ${name} out of ${setPath}:`, err)
    }
  }
}

/**
 * Keep a chat's changes: one squashed commit on the branch each repo's copy was
 * cut from, then the copy is removed.
 *
 * For several repos, every one is asked first and nothing is written until all
 * of them can land — a clash in the third must not leave the first two merged
 * and the chat half-kept. A repo the chat never touched has no worktree, or one
 * with nothing to land, and is simply removed with the rest.
 */
export async function mergeCopy(
  projectPath: string,
  wtPath: string,
  message: string
): Promise<CopyMergeResult> {
  if (!isRepoSet(wtPath)) return mergeWorktree(projectPath, wtPath, message)
  // No worktree is a chat that changed no repo. What it wrote beside them, if
  // anything, is still its work and still goes home below.
  const members = setMembers(wtPath)

  const refusal = (
    m: SetMember,
    r: Exclude<MergeResult, { ok: true }>
  ): Exclude<CopyMergeResult, { ok: true }> =>
    r.reason === 'not-worktree'
      ? { ok: false, reason: 'error', repo: m.name, detail: 'it is not on a branch.' }
      : { ...r, repo: m.name }

  const landing: SetMember[] = []
  for (const m of members) {
    const r = await mergeWorktree(m.repo, m.path, message, { dryRun: true })
    if (r.ok) landing.push(m)
    else if (r.reason !== 'nothing') return refusal(m, r)
  }
  if (landing.length === 0 && looseEntries(wtPath).length === 0) {
    return { ok: false, reason: 'nothing' }
  }

  const kept: string[] = []
  for (const m of landing) {
    const r = await mergeWorktree(m.repo, m.path, message, { cleanup: false })
    if (r.ok) kept.push(m.name)
    // Asked a moment ago and it could: this is a commit hook, or the repo
    // changing underneath. Stop, leave the copy, and say how far it got — the
    // repos already landed have nothing left to land on the next try.
    else if (r.reason !== 'nothing') return { ...refusal(m, r), kept }
  }

  moveLooseHome(wtPath)
  await removeCopy(projectPath, wtPath)
  return { ok: true, committed: true, repos: kept }
}

/**
 * Rename a copy's branch to follow the chat's title — in every repo, to the
 * same name. Only branches the app named are touched.
 */
export async function renameCopy(
  wtPath: string,
  newBranch: string
): Promise<{ ok: boolean; branch: string | null }> {
  if (!isRepoSet(wtPath)) return renameWorktreeBranch(wtPath, newBranch)
  const members = setMembers(wtPath)
  const targets: (SetMember & { own: string })[] = []
  for (const m of members) {
    const head = await git(['symbolic-ref', '--short', 'HEAD'], m.path)
    const own = head.code === 0 ? head.out.trim() : ''
    if (own && isAutoNamed(m.path, own)) targets.push({ ...m, own })
  }
  const meta = readSetMeta(wtPath)
  if (targets.length === 0) {
    // No repo cut yet: the name is only a note of what the first one will be
    // called, so it follows the title like a branch would. Free in every repo
    // it might be cut in, as it was when the copy was made.
    if (members.length > 0 || !meta?.autoName) return { ok: false, branch: null }
    const branch = await freeBranchName(
      linkedRepos(wtPath).map((name) => ({
        repo: join(repoSetRoot(wtPath), name),
        own: meta.branch
      })),
      newBranch,
      reservedBranches(repoSetRoot(wtPath), wtPath)
    )
    writeSetMeta(wtPath, { ...meta, branch })
    return { ok: true, branch }
  }
  const branch = await freeBranchName(targets, newBranch)
  let ok = true
  for (const t of targets) {
    if (t.own === branch) continue
    if ((await git(['branch', '-m', t.own, branch], t.path)).code !== 0) ok = false
  }
  // The repos cut after this are cut on the same name.
  if (ok && meta) writeSetMeta(wtPath, { ...meta, branch })
  return { ok, branch: ok ? branch : targets[0].own }
}

export interface WorktreeSetRow {
  path: string
  /** The branch the copy is on — the first repo's, as they share a name. */
  branch: string | null
  repos: { name: string; branch: string | null }[]
}

/**
 * The copies in a folder of repos, read from disk rather than from what the
 * app recorded — so one whose chat was deleted is still seen, and can still be
 * kept or removed. Empty for a project that is itself a repo: what is in its
 * .worktrees are worktrees, and `git worktree list` already names those.
 */
export function listWorktreeSets(root: string): WorktreeSetRow[] {
  if (gitBranch(root) !== null) return []
  const holder = join(root, '.worktrees')
  let names: string[]
  try {
    names = readdirSync(holder)
  } catch {
    return []
  }
  const out: WorktreeSetRow[] = []
  for (const name of names.sort()) {
    const path = join(holder, name)
    const repos = setMembers(path).map((m) => ({ name: m.name, branch: gitBranch(m.path) }))
    if (repos.length === 0) continue
    out.push({ path, branch: repos[0].branch, repos })
  }
  return out
}

export function registerChatCopyIpc(): void {
  ipcMain.handle('project:copy-kind', (_e, projectPath: string) => copyKind(projectPath))
  // A chat's private copy under <project>/.worktrees/<slug>, on its own branch
  // — parallel chats stop fighting over one working tree.
  ipcMain.handle(
    'worktree:create',
    (
      _e,
      projectPath: string,
      opts?: { branch?: string; newBranch?: string; base?: string; autoName?: boolean }
    ) =>
      copyKind(projectPath) === 'repos'
        ? createWorktreeSet(projectPath, opts)
        : createWorktree(projectPath, opts)
  )
  ipcMain.handle('worktree:sets', (_e, projectPath: string) => listWorktreeSets(projectPath))
  // The chat is about to change this repo: its link becomes its own worktree.
  ipcMain.handle('worktree:cut-repo', (_e, setPath: string, name: string) => cutRepo(setPath, name))
  /**
   * The first message's branch, for the window. The same call the phone's send
   * path makes, so the rule about when a chat gets its own copy has one home.
   */
  ipcMain.handle(
    'chat:ensure-branch',
    async (_e, chatId: string, projectPath: string, hint: string) => {
      // The window claimed its own copy of the flag before calling; drop main's
      // too, so the phone cannot come along and cut a second branch for a chat
      // that already has one.
      takePendingBranch(chatId)
      return cutChatBranch(chatId, projectPath, hint)
    }
  )
  ipcMain.handle('worktree:rename', (_e, wtPath: string, newBranch: string) =>
    renameCopy(wtPath, newBranch)
  )
  ipcMain.handle('worktree:status', (_e, projectPath: string, wtPath: string) =>
    copyStatus(projectPath, wtPath)
  )
  ipcMain.handle('worktree:remove', (_e, projectPath: string, wtPath: string) =>
    removeCopy(projectPath, wtPath)
  )
  ipcMain.handle('worktree:merge', (_e, projectPath: string, wtPath: string, message: string) =>
    mergeCopy(projectPath, wtPath, message)
  )
}
