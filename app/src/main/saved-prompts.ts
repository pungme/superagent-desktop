import { EventEmitter } from 'events'
import { kvDel, kvGet, kvSet } from './store'
import { broadcastToWindows } from './util'
import {
  SAVED_PROMPTS_PREFIX,
  parseSaved,
  withSaved,
  withoutSaved,
  type SavedPrompt
} from '../shared/saved-prompts'

/**
 * Save for later, from the phone's side. The window keeps the list in its
 * localStorage and mirrors it to the database; a phone reads that copy, and
 * what it changes is written there and handed to the window.
 */

/** A chat's list changed (on the Mac or a phone): the phones are told. */
export const savedPromptsBus = new EventEmitter()

export function listSaved(chatId: string): SavedPrompt[] {
  return parseSaved(kvGet(SAVED_PROMPTS_PREFIX + chatId))
}

function write(chatId: string, list: SavedPrompt[]): SavedPrompt[] {
  const key = SAVED_PROMPTS_PREFIX + chatId
  const json = list.length ? JSON.stringify(list) : null
  if (json) kvSet(key, json)
  else kvDel(key)
  broadcastToWindows('saved-prompts:changed', { chatId, json })
  savedPromptsBus.emit('changed', chatId)
  return list
}

export function addSavedPrompt(chatId: string, text: string): SavedPrompt[] {
  if (!text.trim()) return listSaved(chatId)
  return write(chatId, withSaved(listSaved(chatId), text))
}

export function removeSavedPrompt(chatId: string, id: string): SavedPrompt[] {
  return write(chatId, withoutSaved(listSaved(chatId), id))
}

/** The window wrote or removed a list (its mirror): pass it on to the phones. */
export function noteSavedKey(key: string): void {
  if (key.startsWith(SAVED_PROMPTS_PREFIX))
    savedPromptsBus.emit('changed', key.slice(SAVED_PROMPTS_PREFIX.length))
}
