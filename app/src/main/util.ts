import { BrowserWindow } from 'electron'
import { IncomingMessage } from 'http'

/** Send an IPC message to every open window (skipping destroyed ones). */
export function broadcastToWindows(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** Drain an HTTP request body and JSON-parse it; returns {} on empty/invalid. */
export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

/** Push into a per-key ring buffer capped at `max` entries. */
export function pushBounded<T>(map: Map<string, T[]>, key: string, entry: T, max = 200): void {
  const buf = map.get(key) ?? []
  buf.push(entry)
  if (buf.length > max) buf.shift()
  map.set(key, buf)
}

/**
 * Normalize a user/agent-entered URL: bare hosts get a scheme —
 * http:// for localhost/loopback, https:// otherwise.
 */
export function normalizeUrl(raw: string): string {
  const url = raw.trim()
  if (/^[a-z]+:\/\//i.test(url)) return url
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(url)
    ? `http://${url}`
    : `https://${url}`
}

/** The Electron session partition for a workspace's browser panes (visible + offscreen share it). */
export function partitionFor(workspaceId: string): string {
  return `persist:ws-${workspaceId}`
}

/** Encode / decode the offscreen routine pane id (packs workspaceId + "routine"). */
export function routinePaneId(workspaceId: string): string {
  return `${workspaceId}::routine`
}
export function workspaceIdFromPane(paneId: string): string {
  return paneId.split('::')[0]
}
