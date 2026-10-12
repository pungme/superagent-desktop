/**
 * The branches of a project that have no conversation on them: worktrees made
 * outside Superagent, or left behind by an agent. The sidebar is a list of
 * conversations, so these fold into one line under the project instead of
 * each taking a row that says nothing but a branch name.
 */

export interface BranchInfo {
  path: string
  /** Null when the worktree is on no branch (a detached HEAD). */
  branch: string | null
  /** The commit it is at, short. */
  head?: string | null
}

/** A branch that is never deleted with its worktree, whatever else is true. */
export function isHomeBranch(branch: string | null | undefined, home?: string | null): boolean {
  if (!branch) return false
  return branch === 'main' || branch === 'master' || branch === 'develop' || branch === home
}

/** What a row with no conversation is called. */
export function branchLabel(b: BranchInfo): string {
  return b.branch ?? (b.head ? `no branch · at ${b.head}` : 'no branch')
}

/** The line they fold into. */
export function otherBranchesLabel(n: number): string {
  return n === 1 ? '1 other branch' : `${n} other branches`
}

/**
 * Which of them Clean up may remove: nothing of theirs would be lost. Its
 * commits are all in the project's main line already, nothing in it is
 * uncommitted, and it is not a copy of the main line itself.
 */
export function cleanable(
  b: BranchInfo & { merged: boolean; dirty: boolean },
  home?: string | null
): boolean {
  return b.merged && !b.dirty && !isHomeBranch(b.branch, home)
}

/** What the confirmation says before anything goes. */
export function cleanUpQuestion(names: string[]): string {
  return (
    `Remove ${names.length === 1 ? 'this branch' : `these ${names.length} branches`} and ` +
    `${names.length === 1 ? 'its' : 'their'} checkout${names.length === 1 ? '' : 's'}?\n\n` +
    names.map((n) => `  ${n}`).join('\n') +
    '\n\nEverything in them is already in the main line, and nothing is uncommitted. ' +
    'This cannot be undone.'
  )
}
