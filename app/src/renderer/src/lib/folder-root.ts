import { isPendingBranch } from '../state'
import type { Chat } from '../../../preload'

/**
 * Waiting to cut its branch. `pending` is main's kv flag carried on the chat
 * row (the copy the phone writes too); the localStorage read backs it up for
 * the instant between setting the flag and the next chat:list.
 */
export const chatPending = (c: Chat): boolean => c.pending === 1 || isPendingBranch(c.id)

/**
 * The folder's own conversation: nothing has cut a branch for it and nothing
 * else in the workspace has claimed the folder either. A chat waiting on its
 * branch is normally an extra — one typed while another conversation already
 * lived in the folder — except when it is the workspace's ONLY chat, fresh
 * off `newChat`'s auto-create with nothing sent yet. There, "pending" just
 * means no message has decided its home; until one does, it IS the folder's
 * chat, not a phantom branch row alongside an otherwise-empty project.
 */
export const isFolderRoot = (all: Chat[], c: Chat): boolean =>
  !c.cwd && (!chatPending(c) || all.length === 1)
