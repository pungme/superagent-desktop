/**
 * Save for later: prompts set aside in a chat, newest first. Kept in the
 * window's localStorage, which the app mirrors to its database (the key below),
 * so the Mac's composer and a paired phone see the same list.
 */

export interface SavedPrompt {
  id: string
  text: string
  at: number
}

export const SAVED_PROMPTS_PREFIX = 'cove.savedPrompts:'
/** The most kept per chat; past it the oldest goes. */
export const MAX_SAVED = 20

export function parseSaved(json: string | null | undefined): SavedPrompt[] {
  try {
    const list = JSON.parse(json ?? '[]') as SavedPrompt[]
    return Array.isArray(list)
      ? list.filter((p) => p && typeof p.text === 'string' && typeof p.id === 'string')
      : []
  } catch {
    return []
  }
}

/** The list with this text put first (a copy already there moves up), or as it was for blank text. */
export function withSaved(list: SavedPrompt[], text: string, now = Date.now()): SavedPrompt[] {
  const t = text.trim()
  if (!t) return list
  return [
    { id: `${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: t, at: now },
    ...list.filter((p) => p.text !== t)
  ].slice(0, MAX_SAVED)
}

export function withoutSaved(list: SavedPrompt[], id: string): SavedPrompt[] {
  return list.filter((p) => p.id !== id)
}
