import { EventEmitter } from 'events'
import { agentBus, listSessions } from '../agent'
import {
  TranscriptProjector,
  projectLegacyItems,
  toLegacyItems,
  LegacyItem,
  userDisplayText
} from '../transcript'
import {
  appendChatEvent,
  appendChatItems,
  chatEventCount,
  listChatEvents,
  loadChatItems,
  setChatSession
} from '../store'
import type { WireEvent, WireEventData } from '../../shared/companion-protocol'

/**
 * The companion's event log: listens to every agent session, projects the
 * stream into wire events, persists them per chat, and fans them out.
 *
 *  logBus 'event'  { event: WireEvent }            sequenced, persisted
 *  logBus 'delta'  { chatId, text }                ephemeral streaming text
 *
 * Sessions without a window also get their turns written into the renderer's
 * saved transcript (chats.data), so the desktop shows what happened on the
 * phone when a window next opens the chat.
 */
export const logBus = new EventEmitter()
logBus.setMaxListeners(50)

const projectors = new Map<string, TranscriptProjector>()
/** Last ~500 events per chat, so a reconnecting phone rarely touches SQLite. */
const ring = new Map<string, WireEvent[]>()
const RING_MAX = 500

function remember(ev: WireEvent): void {
  const buf = ring.get(ev.chatId) ?? []
  buf.push(ev)
  if (buf.length > RING_MAX) buf.shift()
  ring.set(ev.chatId, buf)
}

/** Persist + fan out one event. Returns the stored event. */
export function record(chatId: string, data: WireEventData): WireEvent {
  ensureBackfilled(chatId)
  const seq = appendChatEvent(chatId, data.kind, data)
  const ev: WireEvent = { chatId, seq, ts: Date.now(), data }
  remember(ev)
  logBus.emit('event', { event: ev })
  return ev
}

/**
 * Everything after `afterSeq`, from memory when possible. `hasMore` tells the
 * caller to page again (the phone asks with the last seq it got).
 */
export function eventsAfter(
  chatId: string,
  afterSeq: number,
  limit = 500
): {
  events: WireEvent[]
  hasMore: boolean
} {
  ensureBackfilled(chatId)
  const buf = ring.get(chatId)
  if (buf && buf.length && buf[0].seq <= afterSeq + 1) {
    const slice = buf.filter((e) => e.seq > afterSeq)
    return { events: slice.slice(0, limit), hasMore: slice.length > limit }
  }
  const rows = listChatEvents(chatId, afterSeq, limit + 1)
  const events = rows.slice(0, limit).map((r) => ({
    chatId: r.chatId,
    seq: r.seq,
    ts: r.ts,
    data: JSON.parse(r.data) as WireEventData
  }))
  return { events, hasMore: rows.length > limit }
}

const backfilled = new Set<string>()

/**
 * A chat from before the log existed gets its saved transcript projected once,
 * so old conversations are readable on the phone without a startup migration.
 */
function ensureBackfilled(chatId: string): void {
  if (backfilled.has(chatId)) return
  backfilled.add(chatId)
  if (chatEventCount(chatId) > 0) return
  const items = loadChatItems(chatId) as LegacyItem[]
  for (const data of projectLegacyItems(items)) {
    const seq = appendChatEvent(chatId, data.kind, data)
    remember({ chatId, seq, ts: Date.now(), data })
  }
}

let started = false

/** Test hook: forget every cached chat so a fresh store reads as fresh. */
export function _resetLogForTests(): void {
  ring.clear()
  backfilled.clear()
  projectors.clear()
  generating.clear()
}

/**
 * Chats with a turn in flight: from the prompt going in until the `result`
 * event (or the process leaving). This is what the desktop's sidebar spinner
 * means by "working" — not "the claude process exists", which it does between
 * turns too.
 */
const generating = new Map<string, string | undefined>() // chatId → workspaceId
export function isGenerating(chatId: string): boolean {
  return generating.has(chatId)
}
export function generatingIn(workspaceId: string): boolean {
  for (const w of generating.values()) if (w === workspaceId) return true
  return false
}
function setGenerating(chatId: string, workspaceId: string | undefined, on: boolean): void {
  const was = generating.has(chatId)
  if (on) generating.set(chatId, workspaceId)
  else generating.delete(chatId)
  if (was !== on) logBus.emit('busy', { chatId, workspaceId })
}

export function startCompanionLog(): void {
  if (started) return
  started = true

  agentBus.on('started', ({ id }: { id: string }) => {
    projectors.set(id, new TranscriptProjector())
  })

  agentBus.on(
    'event',
    ({
      id,
      chatId,
      workspaceId,
      event,
      owned
    }: {
      id: string
      chatId?: string
      workspaceId?: string
      event: Record<string, unknown>
      owned?: boolean
    }) => {
      if (!chatId) return
      if (event.type === 'result') setGenerating(chatId, workspaceId, false)
      let p = projectors.get(id)
      if (!p) {
        p = new TranscriptProjector()
        projectors.set(id, p)
      }
      const out = p.project(event)
      if (out.delta) logBus.emit('delta', { chatId, text: out.delta })
      if (!out.persist.length) return
      const stored = out.persist.map((data) => record(chatId, data))
      // No window is showing this chat: keep the desktop transcript in step,
      // and remember the claude session so it can be resumed later.
      if (!isOwned(id, owned)) {
        appendChatItems(chatId, toLegacyItems(stored.map((e) => e.data)))
        for (const e of stored)
          if (e.data.kind === 'session') setChatSession(chatId, e.data.claudeSessionId)
      }
    }
  )

  agentBus.on(
    'user',
    ({
      id,
      chatId,
      workspaceId,
      text,
      images,
      from,
      localId,
      owned
    }: {
      id: string
      chatId?: string
      workspaceId?: string
      text: string
      images: { mediaType: string; size: number }[]
      from: 'desktop' | 'ios'
      localId?: string
      owned?: boolean
    }) => {
      if (!chatId) return
      setGenerating(chatId, workspaceId, true)
      const data: WireEventData = {
        kind: 'user',
        id: localId ?? `u-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: userDisplayText(text),
        from,
        ...(images.length ? { images } : {})
      }
      const ev = record(chatId, data)
      if (!isOwned(id, owned)) appendChatItems(chatId, toLegacyItems([ev.data]))
    }
  )

  agentBus.on('resume-lost', ({ chatId }: { chatId?: string }) => {
    if (chatId)
      record(chatId, {
        kind: 'notice',
        text: 'This conversation could not be resumed; the agent started fresh.'
      })
  })

  agentBus.on(
    'exit',
    ({ id, chatId, workspaceId }: { id: string; chatId?: string; workspaceId?: string }) => {
      projectors.delete(id)
      if (chatId) setGenerating(chatId, workspaceId, false)
    }
  )
}

// Ownership is asked lazily so a session adopted mid-turn is seen as owned.
function isOwned(id: string, hint?: boolean): boolean {
  if (typeof hint === 'boolean') return hint
  return listSessions().some((s) => s.id === id && s.owned)
}
