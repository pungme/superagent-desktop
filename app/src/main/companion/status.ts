import { hookBus } from '../hooks'

/** Per-workspace agent status, as last reported by the hook server. */
const statuses = new Map<string, 'idle' | 'working' | 'needs-you'>()

let wired = false
export function watchStatuses(): void {
  if (wired) return
  wired = true
  hookBus.on('event', (e: { workspaceId: string; status?: 'idle' | 'working' | 'needs-you' }) => {
    if (e.workspaceId && e.status) statuses.set(e.workspaceId, e.status)
  })
}

export function workspaceStatuses(): Map<string, 'idle' | 'working' | 'needs-you'> {
  return statuses
}
