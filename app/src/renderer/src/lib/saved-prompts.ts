import { useCallback, useEffect, useState } from 'react'

/**
 * Save for later: a prompt set aside so another can be written first (⌘S in the
 * message box). Kept per conversation, newest first, in localStorage (which the
 * app keeps across restarts, see main.tsx); the ⌘K palette lists every chat's.
 */

export interface SavedPrompt {
  id: string
  text: string
  at: number
}

const PREFIX = 'cove.savedPrompts:'
/** Told to every composer and the palette when a list changes. */
export const SAVED_PROMPTS_CHANGED = 'cove:saved-prompts-changed'
/** The most kept per chat; past it the oldest goes. */
export const MAX_SAVED = 20

export function readSaved(chatId: string): SavedPrompt[] {
  try {
    const list = JSON.parse(localStorage.getItem(PREFIX + chatId) ?? '[]') as SavedPrompt[]
    return Array.isArray(list) ? list.filter((p) => p && typeof p.text === 'string') : []
  } catch {
    return []
  }
}

function writeSaved(chatId: string, list: SavedPrompt[]): void {
  if (list.length) localStorage.setItem(PREFIX + chatId, JSON.stringify(list))
  else localStorage.removeItem(PREFIX + chatId)
  window.dispatchEvent(new CustomEvent(SAVED_PROMPTS_CHANGED, { detail: chatId }))
}

/** Set a prompt aside. Returns the list as it is now. */
export function addSaved(chatId: string, text: string, now = Date.now()): SavedPrompt[] {
  const t = text.trim()
  if (!t) return readSaved(chatId)
  const list = [
    { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t, at: now },
    ...readSaved(chatId).filter((p) => p.text !== t)
  ].slice(0, MAX_SAVED)
  writeSaved(chatId, list)
  return list
}

export function removeSaved(chatId: string, id: string): SavedPrompt[] {
  const list = readSaved(chatId).filter((p) => p.id !== id)
  writeSaved(chatId, list)
  return list
}

/** Every chat's saved prompts, newest first, for the palette. */
export function allSaved(): { chatId: string; prompt: SavedPrompt }[] {
  const out: { chatId: string; prompt: SavedPrompt }[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key?.startsWith(PREFIX)) continue
    const chatId = key.slice(PREFIX.length)
    for (const prompt of readSaved(chatId)) out.push({ chatId, prompt })
  }
  return out.sort((a, b) => b.prompt.at - a.prompt.at)
}

/** A chat's saved prompts, kept current wherever they change. */
export function useSavedPrompts(chatId: string): {
  saved: SavedPrompt[]
  add: (text: string) => void
  remove: (id: string) => void
} {
  const [saved, setSaved] = useState<SavedPrompt[]>(() => readSaved(chatId))
  // Another chat in this composer: its own list (set during render, no flash).
  const [forChat, setForChat] = useState(chatId)
  if (forChat !== chatId) {
    setForChat(chatId)
    setSaved(readSaved(chatId))
  }
  useEffect(() => {
    const on = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === chatId) setSaved(readSaved(chatId))
    }
    window.addEventListener(SAVED_PROMPTS_CHANGED, on)
    return () => window.removeEventListener(SAVED_PROMPTS_CHANGED, on)
  }, [chatId])
  const add = useCallback((text: string) => setSaved(addSaved(chatId, text)), [chatId])
  const remove = useCallback((id: string) => setSaved(removeSaved(chatId, id)), [chatId])
  return { saved, add, remove }
}
