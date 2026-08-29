import { ipcMain, powerMonitor, powerSaveBlocker } from 'electron'
import { RelayClient } from './relay-client'
import { ClientConn } from './session'
import { logBus, record, eventsAfter } from './log'
import { hookBus } from '../hooks'
import { listSessions, findSessionByChat, suggestTitle } from '../agent'
import { kvGet, kvSet, getChatIdBySession, getChat, getWorkspace, setChatTitle } from '../store'
import { broadcastToWindows } from '../util'
import { listDevices, removeDevice } from './devices'
import {
  startPairing,
  pendingPairing,
  cancelPairing,
  decidePairing,
  state as pairingState,
  pairingBus
} from './pairing'
import { watchStatuses, effectiveStatus } from './status'
import { startReaper } from './reaper'
import { composePush, pushTargets, testPushTarget, type PushKind } from './push'
import { prettyHostname } from './pairing'
import { EventEmitter } from 'events'
import { loadedMachineId } from './identity'
import { listChats } from './rpc'
import type { WireEvent } from '../../shared/companion-protocol'

/**
 * Wires the companion together: one relay connection, one ClientConn per
 * phone, fan-out from the event log and hook server, Settings IPC, and the
 * keep-awake rule (never let the Mac nap while a phone is watching).
 */

export const DEFAULT_RELAY = 'wss://superagent-relay.superagent-relay.workers.dev'

/** 'state' whenever companionState() changed — the tray listens here. */
export const companionBus = new EventEmitter()
const RELAY_KEY = 'companion.relay'

const relay = new RelayClient()
const conns = new Map<string, ClientConn>()
let blockerId: number | null = null

export function relayUrl(): string {
  // COVE_RELAY_URL: dev/test override (a local relay), never persisted.
  return process.env.COVE_RELAY_URL || kvGet(RELAY_KEY) || DEFAULT_RELAY
}

export function startCompanion(): void {
  watchStatuses()
  startReaper()

  relay.on('open', ({ conn }: { conn: string }) => {
    conns.set(
      conn,
      new ClientConn(
        conn,
        relay,
        () => {
          updateKeepAwake()
          broadcastState()
        },
        (c) => {
          conns.delete(c.id)
          updateKeepAwake()
          broadcastState()
        }
      )
    )
  })
  relay.on('msg', ({ conn, data }: { conn: string; data: string }) => {
    void conns.get(conn)?.receive(data)
  })
  relay.on('close', ({ conn }: { conn: string }) => {
    conns.get(conn)?.dispose()
    conns.delete(conn)
  })
  relay.on('disconnected', () => {
    for (const c of conns.values()) c.dispose()
    conns.clear()
    updateKeepAwake()
  })
  relay.on('state', broadcastState)

  // Fan-out: every phone subscribed to a chat hears its events.
  logBus.on('event', ({ event }: { event: WireEvent }) => {
    for (const c of conns.values())
      if (c.authenticated && c.subs.has(event.chatId)) c.send({ t: 'event', event })
    // A chat's first event makes it "live"/renames it — keep the list fresh.
    if (event.data.kind === 'session' || event.data.kind === 'turn_end') pushChats()
    if (event.data.kind === 'turn_end') void nameIfNeeded(event.chatId)
  })
  logBus.on('delta', ({ chatId, text }: { chatId: string; text: string }) => {
    for (const c of conns.values())
      if (c.authenticated && c.subs.has(chatId)) c.send({ t: 'delta', chatId, text })
  })
  // A turn starting or ending in any chat: the project's status and each
  // chat's `live` flag follow it (see log.ts — this is what the desktop's own
  // spinner means by working; the claude process stays alive between turns).
  logBus.on('busy', ({ workspaceId }: { chatId: string; workspaceId?: string }) => {
    if (workspaceId) {
      const status = effectiveStatus(workspaceId)
      for (const c of conns.values())
        if (c.authenticated) c.send({ t: 'status', workspaceId, status })
    }
    pushChats()
    updateKeepAwake()
  })
  hookBus.on(
    'event',
    (e: {
      workspaceId: string
      event: string
      status?: 'idle' | 'working' | 'needs-you'
      sessionId?: string
      detail?: string
    }) => {
      if (!e.workspaceId || !e.status) return
      for (const c of conns.values())
        if (c.authenticated) c.send({ t: 'status', workspaceId: e.workspaceId, status: e.status })
      updateKeepAwake()
      const chatId = e.sessionId ? chatForSession(e.sessionId) : undefined
      if (e.event === 'Stop')
        notifyPhones('done', { workspaceId: e.workspaceId, chatId, detail: e.detail })
      if (e.event === 'Notification')
        notifyPhones('needs-you', { workspaceId: e.workspaceId, chatId, detail: e.detail })
    }
  )
  // Approvals become log events, so a phone sees them live or on catch-up.
  const approvalChats = new Map<string, string>()
  hookBus.on(
    'approval',
    (a: {
      requestId: string
      workspaceId: string
      sessionId: string
      toolName: string
      preview: string
      kind?: 'guardrail' | 'permission'
      expiresAt: number
    }) => {
      const chatId = chatForSession(a.sessionId)
      if (chatId) {
        approvalChats.set(a.requestId, chatId)
        record(chatId, {
          kind: 'approval',
          id: a.requestId,
          toolName: a.toolName,
          preview: a.preview,
          approvalKind: a.kind ?? 'guardrail',
          expiresAt: a.expiresAt
        })
      }
      notifyPhones('approval', {
        workspaceId: a.workspaceId,
        chatId,
        approvalId: a.requestId,
        detail: a.preview
      })
    }
  )
  hookBus.on(
    'approval-end',
    (e: {
      requestId: string
      outcome: 'approved' | 'denied' | 'expired'
      by: 'desktop' | 'ios'
    }) => {
      const chatId = approvalChats.get(e.requestId)
      approvalChats.delete(e.requestId)
      if (chatId)
        record(chatId, { kind: 'approval_end', id: e.requestId, outcome: e.outcome, by: e.by })
    }
  )
  pairingBus.on('changed', broadcastState)
  pairingBus.on('request', broadcastState)
  pairingBus.on('request', (r: { device: unknown; code: string }) => {
    broadcastToWindows('companion:pairing-request', { device: r.device, code: r.code })
  })

  // Sleep/wake and network changes: reconnect promptly instead of waiting out a backoff.
  powerMonitor.on('resume', () => relay.kick())
  powerMonitor.on('unlock-screen', () => relay.kick())

  // The relay is only dialled when there is a phone to talk to. Pairing
  // starting, finishing, expiring, and a phone being revoked all pass through
  // here, so the connection follows the answer to "is a phone involved?".
  pairingBus.on('changed', syncRelay)
  syncRelay()
}

/** A phone is paired, or one is being paired right now. */
function relayWanted(): boolean {
  return listDevices().length > 0 || pendingPairing() !== null
}

let relayUp = false
/**
 * Bring the relay connection in line with whether a phone is involved. An
 * install that never pairs a phone never opens a socket, never announces its
 * machine id, and never occupies a room on the relay — the companion costs
 * nothing until it is used. Idempotent, so it can be called on every change.
 */
function syncRelay(): void {
  const want = relayWanted()
  if (want && !relayUp) {
    relayUp = true
    relay.start(relayUrl())
  } else if (!want && relayUp) {
    relayUp = false
    relay.stop()
    broadcastState()
  }
}

export function stopCompanion(): void {
  relayUp = false
  relay.stop()
  for (const c of conns.values()) c.dispose()
  conns.clear()
  updateKeepAwake()
}

/**
 * Which chat a claude session id belongs to. Live sessions know directly; a
 * resumed session is found through the chat row that recorded it.
 */
function chatForSession(sessionId: string): string | undefined {
  const byRow = getChatIdBySession(sessionId)
  if (byRow) return byRow
  // A brand-new session hasn't been written to its chat row yet — but the
  // session/init event already went into the log, so the chat is findable.
  for (const s of listSessions()) {
    if (s.chatId && findSessionByChat(s.chatId)?.id === s.id) {
      // Best effort: only one running session means it's this one.
      if (listSessions().length === 1) return s.chatId
    }
  }
  return undefined
}

/**
 * A conversation the phone started has no window to name it. After its first
 * turn, ask the agent for a title the way the desktop chat does, then tell
 * both the phones and the sidebar.
 */
const naming = new Set<string>()
async function nameIfNeeded(chatId: string): Promise<void> {
  const chat = getChat(chatId)
  if (!chat || chat.title || naming.has(chatId)) return
  const session = findSessionByChat(chatId)
  if (session?.owned) return // the window names its own chats
  naming.add(chatId)
  try {
    const ws = getWorkspace(chat.workspaceId)
    const { events } = eventsAfter(chatId, 0)
    const excerpt = events
      .flatMap((e) =>
        e.data.kind === 'user'
          ? [`User: ${e.data.text}`]
          : e.data.kind === 'assistant'
            ? [`Assistant: ${e.data.text}`]
            : []
      )
      .join('\n')
      .slice(0, 1200)
    if (!excerpt) return
    const title = await suggestTitle(chat.cwd ?? ws?.path ?? '', excerpt)
    if (!title || getChat(chatId)?.title) return
    setChatTitle(chatId, title)
    broadcastToWindows('projects:changed')
    pushChats()
  } finally {
    naming.delete(chatId)
  }
}

export function pushChats(): void {
  const chats = listChats()
  for (const c of conns.values()) if (c.authenticated) c.send({ t: 'chats', chats })
}

/**
 * Stay awake while a phone is connected, or while any agent is working and a
 * phone is paired (it may be waiting on the result). Release otherwise.
 */
const KEEP_AWAKE_KEY = 'companion.keepAwakeAlways'
/** Settings → Phone: hold the assertion whenever a phone is paired at all (a Mac left at home). */
export function keepAwakeAlways(): boolean {
  return kvGet(KEEP_AWAKE_KEY) === '1'
}

function updateKeepAwake(): void {
  const phoneConnected = [...conns.values()].some((c) => c.authenticated)
  const paired = listDevices().length > 0
  const working = paired && listSessions().length > 0
  const want = phoneConnected || working || (paired && keepAwakeAlways())
  if (want && blockerId === null) blockerId = powerSaveBlocker.start('prevent-app-suspension')
  if (!want && blockerId !== null) {
    powerSaveBlocker.stop(blockerId)
    blockerId = null
  }
}

export interface CompanionState {
  machineId: string
  relay: { url: string; state: string; error: string }
  devices: ReturnType<typeof listDevices>
  connected: string[]
  pairing: ReturnType<typeof pairingState>
  keepAwake: boolean
  keepAwakeAlways: boolean
}

export function companionState(): CompanionState {
  return {
    machineId: loadedMachineId(),
    relay: { url: relay.relayUrl, state: relay.state, error: relay.lastError },
    devices: listDevices(),
    connected: [...conns.values()].filter((c) => c.authenticated).map((c) => c.deviceId!),
    pairing: pairingState(),
    keepAwake: blockerId !== null,
    keepAwakeAlways: keepAwakeAlways()
  }
}

function broadcastState(): void {
  broadcastToWindows('companion:state', companionState())
  companionBus.emit('state')
}

/**
 * Push a nudge to every paired phone that isn't looking at the app right now.
 * The relay does the APNs call; the Mac never holds the key.
 */
function notifyPhones(
  kind: PushKind,
  e: { workspaceId?: string; chatId?: string; approvalId?: string; detail?: string }
): void {
  const active = new Set(
    [...conns.values()].filter((c) => c.presenceActive && c.deviceId).map((c) => c.deviceId!)
  )
  const targets = pushTargets(kind, active)
  if (!targets.length) return
  const { payload, collapseId } = composePush({ kind, machineName: prettyHostname(), ...e })
  for (const t of targets) relay.push({ token: t.token, env: t.env, payload, collapseId })
}

export function registerCompanionIpc(): void {
  ipcMain.handle('companion:state', () => companionState())
  ipcMain.handle('companion:pair-start', () => startPairing(relayUrl()))
  ipcMain.on('companion:pair-cancel', () => cancelPairing())
  ipcMain.on('companion:pair-decide', (_e, accepted: boolean) => decidePairing(accepted))
  ipcMain.on('companion:revoke', (_e, id: string) => {
    removeDevice(id)
    for (const c of conns.values()) if (c.deviceId === id) c.close()
    syncRelay()
    broadcastState()
  })
  ipcMain.on('companion:set-relay', (_e, url: string) => {
    const clean = url.trim().replace(/\/+$/, '')
    kvSet(RELAY_KEY, clean === DEFAULT_RELAY ? '' : clean)
    if (relayUp) relay.restart(relayUrl())
    broadcastState()
  })
  ipcMain.on('companion:reconnect', () => {
    if (relayUp) relay.kick()
    else syncRelay()
  })
  ipcMain.on('companion:set-keep-awake', (_e, always: boolean) => {
    kvSet(KEEP_AWAKE_KEY, always ? '1' : '')
    updateKeepAwake()
    broadcastState()
  })
  // "Test notification": one banner to one phone, so you can see it works
  // before you rely on it. False when that phone never registered for push.
  ipcMain.handle('companion:test-push', (_e, id: string): boolean => {
    const t = testPushTarget(id)
    if (!t) return false
    const { payload, collapseId } = composePush({ kind: 'test', machineName: prettyHostname() })
    relay.push({ token: t.token, env: t.env, payload, collapseId: collapseId + ':test' })
    return true
  })
}
