import {
  appendChatItems,
  createChat,
  getChat,
  getChatModel,
  loadChatItems,
  markPendingBranch,
  setChatModel,
  setChatPinnedAfter,
  setChatProvider,
  setChatTitle,
  DESKTOP_WORKSPACE_ID
} from './store'
import { markContextCopied } from './agent'
import { flushAllTranscripts } from './transcripts'

/**
 * Duplicate a conversation: the same project, agent and model, the whole
 * transcript, and its agent catches up from a recap on the first message (it
 * has no memory of the original; see agent.ts takeRecap). The copy is pinned,
 * right below the original, when the original is.
 *
 * It starts like "+ New chat": in a project it cuts its own copy of the folder on
 * its first message, so two conversations never work in one folder at once (and a
 * chat that already works in its own branch is not copied into the same branch).
 */
export async function duplicateChat(
  sourceId: string
): Promise<{ workspaceId: string; chatId: string } | null> {
  const source = getChat(sourceId)
  if (!source) return null
  // What the window has not saved yet would be missing from the copy.
  await flushAllTranscripts(3000).catch(() => [])
  const chatId = createChat(source.workspaceId)
  if (source.workspaceId !== DESKTOP_WORKSPACE_ID) markPendingBranch(chatId)
  if (source.provider) setChatProvider(chatId, source.provider as never)
  const model = getChatModel(sourceId)
  if (model) setChatModel(chatId, model)
  if (source.title) setChatTitle(chatId, `${source.title} (copy)`)
  const items = loadChatItems(sourceId)
  if (items.length) {
    await appendChatItems(chatId, items)
    markContextCopied(chatId)
  }
  if (source.pinned) setChatPinnedAfter(chatId, sourceId)
  return { workspaceId: source.workspaceId, chatId }
}
