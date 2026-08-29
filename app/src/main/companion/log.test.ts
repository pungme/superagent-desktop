import { describe, it, expect, vi, beforeEach } from 'vitest'

// The log talks to SQLite through store.ts, which needs Electron at import
// time. Replace both with an in-memory stand-in so the sequencing, backfill and
// fan-out logic is what gets tested.
const { mem, fakeBus } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events') as typeof import('events')
  return {
    mem: {
      events: new Map<string, { seq: number; kind: string; data: string; ts: number }[]>(),
      items: new Map<string, unknown[]>(),
      owned: new Map<string, boolean>()
    },
    fakeBus: new EventEmitter()
  }
})

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  ipcMain: { handle: () => undefined, on: () => undefined }
}))
vi.mock('../store', () => ({
  appendChatEvent: (chatId: string, kind: string, data: unknown) => {
    const buf = mem.events.get(chatId) ?? []
    const seq = buf.length + 1
    buf.push({ seq, kind, data: JSON.stringify(data), ts: Date.now() })
    mem.events.set(chatId, buf)
    return seq
  },
  listChatEvents: (chatId: string, afterSeq: number, limit: number) =>
    (mem.events.get(chatId) ?? [])
      .filter((e) => e.seq > afterSeq)
      .slice(0, limit)
      .map((e) => ({ chatId, ...e })),
  chatEventCount: (chatId: string) => (mem.events.get(chatId) ?? []).length,
  loadChatItems: (chatId: string) => mem.items.get(chatId) ?? [],
  setChatSession: () => undefined,
  appendChatItems: (chatId: string, items: unknown[]) =>
    mem.items.set(chatId, [...(mem.items.get(chatId) ?? []), ...items])
}))

vi.mock('../agent', () => ({
  agentBus: fakeBus,
  listSessions: () => [...mem.owned.entries()].map(([id, owned]) => ({ id, owned, chatId: 'c1' }))
}))

import { startCompanionLog, logBus, eventsAfter, record, _resetLogForTests } from './log'

describe('companion log', () => {
  beforeEach(() => {
    mem.events.clear()
    mem.items.clear()
    mem.owned.clear()
    _resetLogForTests()
    logBus.removeAllListeners()
    startCompanionLog()
  })

  it('numbers events per chat and fans them out', () => {
    const seen: number[] = []
    logBus.on('event', ({ event }) => seen.push(event.seq))
    record('c1', { kind: 'notice', text: 'a' })
    record('c1', { kind: 'notice', text: 'b' })
    record('c2', { kind: 'notice', text: 'x' })
    expect(seen).toEqual([1, 2, 1])
    expect(eventsAfter('c1', 0).events.map((e) => e.seq)).toEqual([1, 2])
    expect(eventsAfter('c1', 1).events.map((e) => e.seq)).toEqual([2])
    expect(eventsAfter('c1', 2).events).toEqual([])
  })

  it('backfills a legacy transcript the first time a chat is touched', () => {
    mem.items.set('old', [
      { kind: 'msg', msg: { id: 'u', role: 'user', text: 'hi' } },
      { kind: 'msg', msg: { id: 'a', role: 'assistant', text: 'hello' } }
    ])
    const { events } = eventsAfter('old', 0)
    expect(events.map((e) => e.data.kind)).toEqual(['user', 'assistant'])
    // A second look does not backfill twice.
    expect(eventsAfter('old', 0).events).toHaveLength(2)
  })

  it('projects agent stream events and mirrors unowned turns into chats.data', () => {
    mem.owned.set('s1', false)
    const deltas: string[] = []
    logBus.on('delta', ({ text }) => deltas.push(text))
    fakeBus.emit('started', { id: 's1', chatId: 'c1' })
    fakeBus.emit('event', {
      id: 's1',
      chatId: 'c1',
      event: {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } }
      }
    })
    fakeBus.emit('event', {
      id: 's1',
      chatId: 'c1',
      event: {
        type: 'assistant',
        message: { id: 'm', content: [{ type: 'text', text: 'Hi there' }] }
      }
    })
    expect(deltas).toEqual(['Hi'])
    expect(eventsAfter('c1', 0).events.map((e) => e.data.kind)).toEqual(['assistant'])
    // Unowned session → the desktop transcript got the same message.
    expect(mem.items.get('c1')).toEqual([
      { kind: 'msg', msg: { id: 'm-0', role: 'assistant', text: 'Hi there' } }
    ])
  })

  it('does not touch chats.data for a session a window owns', () => {
    mem.owned.set('s2', true)
    fakeBus.emit('user', { id: 's2', chatId: 'c1', text: 'yo', images: [], from: 'desktop' })
    expect(eventsAfter('c1', 0).events[0].data).toMatchObject({ kind: 'user', text: 'yo' })
    expect(mem.items.get('c1')).toBeUndefined()
  })

  it('keeps the phone-supplied localId as the user event id', () => {
    mem.owned.set('s3', false)
    fakeBus.emit('user', {
      id: 's3',
      chatId: 'c1',
      text: 'from phone',
      images: [],
      from: 'ios',
      localId: 'L1'
    })
    expect(eventsAfter('c1', 0).events[0].data).toMatchObject({ id: 'L1', from: 'ios' })
  })
})
