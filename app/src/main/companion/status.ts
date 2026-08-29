import { hookBus } from '../hooks'
import { agentBus, listSessions } from '../agent'
import { generatingIn } from './log'

/** Per-workspace agent status, as last reported by the hook server. */
const statuses = new Map<string, 'idle' | 'working' | 'needs-you'>()

let wired = false
export function watchStatuses(): void {
  if (wired) return
  wired = true
  hookBus.on('event', (e: { workspaceId: string; status?: 'idle' | 'working' | 'needs-you' }) => {
    if (e.workspaceId && e.status) statuses.set(e.workspaceId, e.status)
  })
  // The hooks say what the agent is doing; the process says whether it is
  // there at all. A turn that ends without a Stop hook (interrupted, crashed,
  // hooks not installed) would otherwise leave "working" on for good.
  agentBus.on('started', ({ workspaceId }: { workspaceId?: string }) => {
    if (workspaceId) statuses.set(workspaceId, 'working')
  })
  agentBus.on('exit', ({ workspaceId }: { workspaceId?: string }) => {
    if (!workspaceId) return
    const stillRunning = listSessions().some((s) => s.workspaceId === workspaceId)
    if (!stillRunning) statuses.set(workspaceId, 'idle')
  })
}

export function workspaceStatuses(): Map<string, 'idle' | 'working' | 'needs-you'> {
  const out = new Map(statuses)
  for (const [id, s] of out) out.set(id, effectiveStatus(id, s))
  return out
}

/**
 * What the phone shows for a project: a turn in flight wins; a hook-reported
 * needs-you stands while it's the latest word; otherwise idle — "working" from
 * a hook with no turn in flight is stale.
 */
export function effectiveStatus(
  workspaceId: string,
  hook: 'idle' | 'working' | 'needs-you' = statuses.get(workspaceId) ?? 'idle'
): 'idle' | 'working' | 'needs-you' {
  if (generatingIn(workspaceId)) return hook === 'needs-you' ? 'needs-you' : 'working'
  return hook === 'needs-you' ? 'needs-you' : 'idle'
}
