import { devicesWithPush } from './devices'
import { notifyPrefs } from '../hooks'
import { getWorkspaceName } from '../store'

/**
 * What the Mac asks the relay to push, and when.
 *
 * The relay holds the APNs key; the Mac only composes the notification. Push
 * is a nudge: the phone fetches the real state when opened, so payloads stay
 * small and never carry a full transcript. Nothing is pushed to a phone that
 * is on screen right now (it already sees the event live).
 */

export interface PushRequest {
  token: string
  env: 'production' | 'sandbox'
  payload: Record<string, unknown>
  collapseId?: string
  pushType?: 'alert'
}

export type PushKind = 'approval' | 'done' | 'needs-you' | 'test'

export interface PushEvent {
  kind: PushKind
  workspaceId?: string
  chatId?: string
  approvalId?: string
  /** For 'approval': what the agent wants to do. For 'done': the reply's first line. */
  detail?: string
  machineName: string
}

/** Pure: the APNs payload for an event. */
export function composePush(e: PushEvent): {
  payload: Record<string, unknown>
  collapseId: string
} {
  const project = e.workspaceId ? getWorkspaceName(e.workspaceId) : undefined
  const where = project ? `${e.machineName} · ${project}` : e.machineName
  let title: string
  let body: string
  let category: string
  switch (e.kind) {
    case 'approval':
      title = 'Claude wants to act'
      body = e.detail ? e.detail.slice(0, 140) : 'Approve or deny from here.'
      category = 'APPROVAL'
      break
    case 'done':
      title = 'Claude is done'
      body = e.detail ? e.detail.slice(0, 140) : 'Tap to see what it did.'
      category = 'DONE'
      break
    case 'test':
      title = 'Notifications are on'
      body = `This phone will hear from ${e.machineName} when Claude needs you.`
      category = 'DONE'
      break
    default:
      title = 'Claude needs you'
      body = e.detail ? e.detail.slice(0, 140) : 'The agent is waiting for your input.'
      category = 'DONE'
  }
  return {
    payload: {
      aps: {
        alert: { title, subtitle: where, body },
        sound: 'default',
        category,
        'thread-id': e.chatId ?? e.workspaceId ?? 'superagent',
        'interruption-level': e.kind === 'approval' ? 'time-sensitive' : 'active'
      },
      sa: {
        kind: e.kind,
        chatId: e.chatId ?? null,
        workspaceId: e.workspaceId ?? null,
        approvalId: e.approvalId ?? null
      }
    },
    collapseId: e.approvalId ?? e.chatId ?? 'superagent'
  }
}

/**
 * Which devices should hear about this event: paired, with a push token, not
 * currently on screen, and the user hasn't turned that kind of banner off.
 */
export function pushTargets(
  kind: PushKind,
  activeDeviceIds: Set<string>
): { deviceId: string; token: string; env: 'production' | 'sandbox' }[] {
  // A test goes to the one phone that asked for it, even while it's on screen.
  if (kind === 'test') return []
  if (kind === 'done' && !notifyPrefs.done) return []
  if (kind !== 'done' && !notifyPrefs.needsYou) return []
  return devicesWithPush()
    .filter((d) => !activeDeviceIds.has(d.id) && d.pushToken)
    .map((d) => ({ deviceId: d.id, token: d.pushToken!, env: d.pushEnv }))
}

/** The one phone a "Test notification" button points at, if it can be pushed to. */
export function testPushTarget(
  deviceId: string
): { deviceId: string; token: string; env: 'production' | 'sandbox' } | null {
  const d = devicesWithPush().find((x) => x.id === deviceId)
  return d?.pushToken ? { deviceId: d.id, token: d.pushToken, env: d.pushEnv } : null
}
