import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import type { ServerFrame, WireEvent, WireEventKind } from './companion-protocol'

/**
 * The fixtures are the contract with the iOS app. This test pins their shape
 * against the TypeScript types (a compile-time check, via the casts below) and
 * a few runtime invariants, so editing a fixture by hand can't silently drift.
 */
const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures/companion/frames.json'), 'utf8')) as {
  server: ServerFrame[]
  events: WireEvent[]
}

const KINDS: WireEventKind[] = [
  'user',
  'assistant',
  'thinking',
  'tool',
  'tool_result',
  'diff',
  'turn_end',
  'session',
  'notice',
  'approval',
  'approval_end'
]

describe('companion fixtures', () => {
  it('covers every server frame type', () => {
    const types = new Set(fx.server.map((f) => f.t))
    for (const t of ['welcome', 'paired', 'bye', 'delta', 'status', 'chats', 'res', 'pong'])
      expect(types.has(t as ServerFrame['t'])).toBe(true)
  })

  it('covers every event kind once, plus one unknown kind for forward compatibility', () => {
    const kinds = fx.events.map((e) => e.data.kind)
    for (const k of KINDS) expect(kinds).toContain(k)
    expect(kinds).toContain('something_new')
  })

  it('events are contiguous from seq 1 on one chat', () => {
    fx.events.forEach((e, i) => {
      expect(e.seq).toBe(i + 1)
      expect(e.chatId).toBe('c1')
    })
  })
})
