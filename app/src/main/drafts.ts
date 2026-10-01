import { BrowserWindow, ipcMain } from 'electron'
import { EventEmitter } from 'events'
import { chatDraft, setChatDraft } from './store'

/**
 * What is typed in a conversation and not sent yet.
 *
 * One copy per chat, held here: a window reads it when the chat opens and
 * writes it as you type, so quitting does not lose a half-written message, and
 * the phone reads and writes the same one, so a sentence started on the Mac can
 * be finished there. Text only; attached pictures and files stay where they
 * were picked.
 *
 *  draftBus 'changed'  { chatId, text, origin }   `origin` is whoever wrote it
 *                                                 (a window, a phone), so it
 *                                                 is not sent its own words.
 */
export const draftBus = new EventEmitter()
draftBus.setMaxListeners(50)

/** Far past anything typed by hand; a pasted log should not be mirrored around. */
const MAX_DRAFT = 20_000

export function draftOf(chatId: string): string {
  try {
    return chatDraft(chatId)
  } catch {
    return ''
  }
}

/** Store a chat's draft and tell everyone but `origin`. False if nothing changed. */
export function saveDraft(chatId: string, raw: string, origin: unknown): boolean {
  if (typeof chatId !== 'string' || typeof raw !== 'string') return false
  const text = raw.trim() ? raw.slice(0, MAX_DRAFT) : ''
  try {
    if (chatDraft(chatId) === text) return false
    if (!setChatDraft(chatId, text)) return false
  } catch {
    return false
  }
  draftBus.emit('changed', { chatId, text, origin })
  return true
}

export function registerDrafts(): void {
  ipcMain.handle('draft:get', (_e, chatId: string) => draftOf(chatId))
  ipcMain.on('draft:set', (e, chatId: string, text: string) => {
    saveDraft(chatId, text, e.sender)
  })
  draftBus.on('changed', (d: { chatId: string; text: string; origin: unknown }) => {
    for (const win of BrowserWindow.getAllWindows()) {
      const wc = win.webContents
      if (wc === d.origin || wc.isDestroyed()) continue
      wc.send('draft:changed', { chatId: d.chatId, text: d.text })
    }
  })
}
