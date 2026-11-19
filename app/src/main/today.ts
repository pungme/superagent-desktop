import { ipcMain } from 'electron'
import { writeFileSync } from 'fs'
import { join } from 'path'
import { dayNotes, TODAY_ASSISTANT_RULES } from '../shared/today'
import {
  createChat,
  getChat,
  kvGet,
  kvSet,
  listCalendarEvents,
  setChatTitle,
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

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/**
 * The Today box's own conversation: one, kept, under Chats. It is the assistant
 * that finds the right existing conversation for a request and hands it the work
 * (app_find_chats / app_send_message), so a request does not start a new chat
 * every time.
 */
function assistantChat(): { chatId: string; workspaceId: string; cwd: string } {
  const desk = ensureDesktopWorkspace()
  const known = kvGet('today.chatId')
  if (known && getChat(known))
    return { chatId: known, workspaceId: desk.workspaceId, cwd: desk.cwd }
  const chatId = createChat(desk.workspaceId)
  setChatTitle(chatId, 'Today')
  kvSet('today.chatId', chatId)
  broadcastToWindows('projects:changed', {})
  return { chatId, workspaceId: desk.workspaceId, cwd: desk.cwd }
}

/** Today's calendar and to-dos for the assistant to read, as a file next to its chat. */
function writeDayNotes(cwd: string): void {
  const now = new Date()
  const next = new Date(now.getTime() + 86_400_000)
  const text = dayNotes(
    now,
    listCalendarEvents(ymd(now), ymd(next)),
    openCards(),
    (ws) => getWorkspace(ws)?.name ?? 'Project'
  )
  writeFileSync(join(cwd, 'today.md'), `${text}\n${TODAY_ASSISTANT_RULES}`)
}

/**
 * The ask box: the request goes to the Today assistant, which has the day's
 * notes and the tools to find the right conversation and send it the work.
 */
export async function todayAsk(text: string): Promise<Sent> {
  const said = String(text ?? '').trim()
  if (!said) return { ok: false, error: 'Nothing to send.' }
  const { chatId, workspaceId, cwd } = assistantChat()
  try {
    writeDayNotes(cwd)
  } catch {
    // Without the notes it still routes; it just cannot answer about the day.
  }
  const { askFromDot } = await import('./companion/rpc')
  const sent = await askFromDot(
    chatId,
    `${said}\n\n(Today box: today.md in this folder has my calendar and to-dos, and how to handle this.)`
  )
  return sent.ok ? { ok: true, chatId, workspaceId } : { ok: false, error: sent.error }
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
