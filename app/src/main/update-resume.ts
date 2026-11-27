import { kvDel, kvGet, kvSet } from './store'

/**
 * "Restart now" while agents are mid-turn: the chats that were working are written down before
 * the app goes, and when the new version is up each gets a message to carry on. Nobody has to
 * wait for the agents to finish, or come back to retype "continue".
 */
const KEY = 'resumeAfterUpdate'
/** A restart that took longer than this was not "an update": do not wake old chats. */
const MAX_AGE_MS = 30 * 60_000

export const RESUME_TEXT =
  'Superagent was updated and restarted while you were working, which stopped anything that was running: ' +
  'your current step, background tasks and servers. Check where you were and carry on with the task.'

let busyProbe: () => string[] = () => []
/** index.ts hands in which chats are working right now (the log lives there). */
export function setBusyChatsProbe(fn: () => string[]): void {
  busyProbe = fn
}

/** Write down the working chats; called just before the app quits to install. */
export function recordInterrupted(now = Date.now()): string[] {
  const chatIds = busyProbe()
  if (chatIds.length) kvSet(KEY, JSON.stringify({ at: now, chatIds }))
  return chatIds
}

/** Read and clear what was written down: once, however many starts follow. */
export function takeInterrupted(now = Date.now()): string[] {
  const raw = kvGet(KEY)
  if (!raw) return []
  kvDel(KEY)
  try {
    const v = JSON.parse(raw) as { at?: number; chatIds?: unknown }
    if (typeof v.at !== 'number' || now - v.at > MAX_AGE_MS || !Array.isArray(v.chatIds)) return []
    return v.chatIds.filter((c): c is string => typeof c === 'string')
  } catch {
    return []
  }
}

/** Send the carry-on message to each chat that still exists. */
export async function resumeInterrupted(
  send: (chatId: string, text: string) => Promise<unknown>,
  exists: (chatId: string) => boolean
): Promise<string[]> {
  const done: string[] = []
  for (const id of takeInterrupted()) {
    if (!exists(id)) continue
    try {
      await send(id, RESUME_TEXT)
      done.push(id)
    } catch {
      // the chat is still there; the person can say continue themselves
    }
  }
  return done
}
