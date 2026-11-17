import { ipcMain } from 'electron'
import {
  createChat,
  DESKTOP_WORKSPACE_ID,
  ensureDesktopWorkspace,
  getCard,
  getWorkspace,
  markPendingBranch,
  moveCard,
  openCards,
  updateCard
} from './store'
import { broadcastToWindows } from './util'

/**
 * Today: one screen for the day — the calendar, every project's open to-dos,
 * and what the agents are doing. This is the part that needs main: the to-dos
 * across projects, handing one to an agent (a new chat of its own in that
 * project, sent the card as its first message), and the ask box, which starts
 * a chat under Chats the way the dot does, without a look at the screen.
 */

const cardText = (c: { title: string; body: string }): string =>
  c.body ? `${c.title}\n\n${c.body}` : c.title

type Sent = { ok: true; chatId: string; workspaceId: string } | { ok: false; error: string }

/** A new chat with this as its first message. In a project it gets its own branch, like "+ New chat". */
async function startChat(workspaceId: string, text: string): Promise<Sent> {
  const wsId =
    workspaceId === DESKTOP_WORKSPACE_ID ? ensureDesktopWorkspace().workspaceId : workspaceId
  if (!getWorkspace(wsId)) return { ok: false, error: 'That project is gone.' }
  const chatId = createChat(wsId)
  if (wsId !== DESKTOP_WORKSPACE_ID) markPendingBranch(chatId)
  broadcastToWindows('projects:changed', {})
  const { askFromDot } = await import('./companion/rpc')
  const sent = await askFromDot(chatId, text)
  return sent.ok ? { ok: true, chatId, workspaceId: wsId } : { ok: false, error: sent.error }
}

/** The ask box: a question for the agent that is not tied to a project, in a new chat under Chats. */
export function todayAsk(text: string): Promise<Sent> {
  const said = String(text ?? '').trim()
  if (!said) return Promise.resolve({ ok: false, error: 'Nothing to send.' })
  return startChat(DESKTOP_WORKSPACE_ID, said)
}

/** Hand a to-do to an agent: it moves to Doing, and a chat of its own in its project works on it. */
export async function handCard(cardId: string): Promise<Sent> {
  const card = getCard(cardId)
  if (!card) return { ok: false, error: 'That to-do is gone.' }
  const sent = await startChat(card.workspaceId, cardText(card))
  if (!sent.ok) return sent
  moveCard(card.id, 'doing', null)
  updateCard(card.id, { chatId: sent.chatId })
  broadcastToWindows('board:changed', { workspaceId: card.workspaceId })
  return sent
}

export function registerTodayIpc(): void {
  ipcMain.handle('today:cards', () => openCards())
  ipcMain.handle('today:ask', (_e, text: string) => todayAsk(String(text ?? '')))
  ipcMain.handle('today:hand', (_e, cardId: string) => handCard(String(cardId)))
}
