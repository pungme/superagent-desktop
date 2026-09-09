import { isPendingBranch } from '../state'
import type { Chat } from '../../../preload'

/** Main's durable flag, with localStorage as the same-render fallback. */
export const chatPending = (c: Chat): boolean => c.pending === 1 || isPendingBranch(c.id)

/**
 * A pending chat is normally an extra that will get its own worktree. The sole
 * chat in a newly added project is different: until there is another chat to
 * distinguish it from, it belongs on the project row rather than under a
 * phantom "no branch yet" child.
 */
export const isFolderRoot = (all: Chat[], c: Chat): boolean =>
  !c.cwd && (!chatPending(c) || all.length === 1)
