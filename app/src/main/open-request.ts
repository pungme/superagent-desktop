import { ipcMain } from 'electron'
import { broadcastToWindows } from './util'

/**
 * "Show the user this conversation", asked from outside the window: by the
 * dot, by an agent's app_* tools, by a shortcut.
 *
 * The window may not be there to be told. Closing it leaves Superagent
 * running (the dot stays, agents go on), and asking for a project then opens
 * a new window, which has not loaded when the request is sent: it arrived
 * nowhere, and the app came up on whatever it last showed. So the request is
 * also kept, briefly, for a window to collect when it starts.
 */

/** How long a request waits for a window to come up and take it. */
export const OPEN_KEEP_MS = 20_000

export interface OpenRequest {
  workspaceId: string
  /** Empty: the project, not one conversation in it. */
  chatId: string
}

let pending: (OpenRequest & { at: number }) | null = null

/** Tell every window that is listening, and keep it for one that is not yet. */
export function askToOpen(workspaceId: string, chatId: string, now = Date.now()): void {
  pending = { workspaceId, chatId, at: now }
  broadcastToWindows('dot:open-chat', { workspaceId, chatId })
}

/** The request a starting window should act on, once; null when none is fresh. */
export function takePendingOpen(now = Date.now()): OpenRequest | null {
  const p = pending
  pending = null
  return p && now - p.at < OPEN_KEEP_MS ? { workspaceId: p.workspaceId, chatId: p.chatId } : null
}

export function registerOpenRequests(): void {
  ipcMain.handle('app:pending-open', () => takePendingOpen())
  // A window that was there and heard it: nothing left for the next one.
  ipcMain.on('app:open-delivered', () => {
    pending = null
  })
}
