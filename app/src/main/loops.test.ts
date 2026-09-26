import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events') as typeof import('events')
  return {
    agentBus: new EventEmitter(),
    logBus: new EventEmitter(),
    generating: new Set<string>(),
    onHandlers: new Map<string, (...a: unknown[]) => void>(),
    /** What the window does with a round: take it, say busy, or not be there. */
    window: 'none' as 'taken' | 'busy' | 'none',
    rounds: [] as { chatId: string; text: string }[],
    session: null as null | { id: string },
    sendToAgent: vi.fn(() => true),
    record: vi.fn()
  }
})

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    on: (ch: string, fn: (...a: unknown[]) => void) => h.onHandlers.set(ch, fn)
  }
}))
vi.mock('./util', () => ({
  broadcastToWindows: (ch: string, p: { chatId: string; text: string; nonce: string }) => {
    if (ch !== 'loops:round' || h.window === 'none') return
    h.rounds.push({ chatId: p.chatId, text: p.text })
    h.onHandlers.get('loops:round-reply')?.({}, p.nonce, h.window)
  }
}))
vi.mock('./agent', () => ({
  agentBus: h.agentBus,
  findSessionByChat: () => h.session,
  sendToAgent: h.sendToAgent
}))
vi.mock('./companion/log', () => ({
  logBus: h.logBus,
  isGenerating: (id: string) => h.generating.has(id),
  record: h.record
}))
vi.mock('./store', () => ({ getChat: (id: string) => (id === 'gone' ? undefined : { id }) }))

import {
  loopCommand,
  loopFor,
  registerLoops,
  requestLoopWait,
  setUnattendedSend,
  _resetLoopsForTests
} from './loops'
import { LOOP_CAP, parseLoopCmd, SELF_PACE_NOTE } from '../shared/loop'

registerLoops()

function turn(chatId: string): void {
  h.generating.add(chatId)
  h.logBus.emit('busy', { chatId })
  h.generating.delete(chatId)
  h.logBus.emit('busy', { chatId })
}

beforeEach(() => {
  vi.useFakeTimers()
  h.window = 'taken'
  h.rounds.length = 0
  h.session = null
  h.generating.clear()
  h.sendToAgent.mockClear()
  h.record.mockClear()
})
afterEach(() => {
  _resetLoopsForTests()
  vi.useRealTimers()
})

describe('parseLoopCmd', () => {
  it('reads the forms the terminal takes', () => {
    expect(parseLoopCmd('/loop 5m check CI')).toEqual({
      kind: 'start',
      intervalMs: 300_000,
      prompt: 'check CI'
    })
    expect(parseLoopCmd('/loop check CI every 2 hours')).toEqual({
      kind: 'start',
      intervalMs: 7_200_000,
      prompt: 'check CI'
    })
    expect(parseLoopCmd('/loop keep going')).toEqual({
      kind: 'start',
      intervalMs: null,
      prompt: 'keep going'
    })
    expect(parseLoopCmd('/loop stop')).toEqual({ kind: 'stop' })
    expect(parseLoopCmd('/loop')).toEqual({ kind: 'usage' })
    expect(parseLoopCmd('/looper')).toBeNull()
    expect(parseLoopCmd('hello')).toBeNull()
  })
})

describe('loops', () => {
  it('runs a self-paced loop round after round, through the window showing the chat', async () => {
    expect(loopCommand('c1', '/loop tidy up')).toMatch(/Looping/)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rounds).toEqual([{ chatId: 'c1', text: 'tidy up' + SELF_PACE_NOTE }])
    expect(loopFor('c1')).toMatchObject({ prompt: 'tidy up', intervalMs: null, count: 1 })

    turn('c1')
    // Default gap: nothing before a minute, the next round right after.
    await vi.advanceTimersByTimeAsync(59_000)
    expect(h.rounds).toHaveLength(1)
    expect(loopFor('c1')?.nextAt).toBeTypeOf('number')
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.rounds).toHaveLength(2)
    expect(loopFor('c1')?.count).toBe(2)
  })

  it("waits as long as the agent's loop_wait asked", async () => {
    loopCommand('c1', '/loop watch the deploy')
    await vi.advanceTimersByTimeAsync(0)
    requestLoopWait('c1', 600)
    turn('c1')
    await vi.advanceTimersByTimeAsync(599_000)
    expect(h.rounds).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(h.rounds).toHaveLength(2)
  })

  it('fires an interval loop on its clock and skips a tick while a turn is running', async () => {
    loopCommand('c1', '/loop 5m check prices')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rounds.map((r) => r.text)).toEqual(['check prices'])
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.rounds).toHaveLength(2)
    h.generating.add('c1')
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.rounds).toHaveLength(2)
    h.generating.delete('c1')
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.rounds).toHaveLength(3)
  })

  it('with no window open, hands the round to the live agent and shows it in its window', async () => {
    h.window = 'none'
    h.session = { id: 's1' }
    loopCommand('c1', '/loop 5m ping')
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.sendToAgent).toHaveBeenCalledWith('s1', 'ping', [], {
      from: 'desktop',
      notifyOwner: true
    })
  })

  it('with no window and no agent, starts one the way the phone does', async () => {
    h.window = 'none'
    const unattended = vi.fn(async () => true)
    setUnattendedSend(unattended)
    loopCommand('c1', '/loop 5m ping')
    await vi.advanceTimersByTimeAsync(1000)
    expect(unattended).toHaveBeenCalledWith('c1', 'ping')
    expect(loopFor('c1')?.count).toBe(1)
  })

  it('holds a round while the window says its agent is busy, and does not count it', async () => {
    h.window = 'busy'
    loopCommand('c1', '/loop keep going')
    await vi.advanceTimersByTimeAsync(0)
    expect(loopFor('c1')?.count).toBe(0)
    h.window = 'taken'
    await vi.advanceTimersByTimeAsync(5000)
    expect(loopFor('c1')?.count).toBe(1)
  })

  it('moves on if a handed-over round never starts a turn', async () => {
    loopCommand('c1', '/loop keep going')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(45_000 + 60_000)
    expect(h.rounds).toHaveLength(2)
  })

  it('stops on /loop stop, on an interrupt, and at the cap', async () => {
    loopCommand('c1', '/loop 1m a')
    expect(loopCommand('c1', '/loop stop')).toBe('⏹ Loop stopped.')
    expect(loopFor('c1')).toBeNull()
    expect(loopCommand('c1', '/loop stop')).toMatch(/No loop/)

    loopCommand('c2', '/loop b')
    await vi.advanceTimersByTimeAsync(0)
    h.agentBus.emit('interrupted', { chatId: 'c2' })
    expect(loopFor('c2')).toBeNull()
    expect(h.record).toHaveBeenCalledWith('c2', {
      kind: 'notice',
      text: expect.stringMatching(/interrupted/)
    })

    loopCommand('c3', '/loop 1s c')
    await vi.advanceTimersByTimeAsync(LOOP_CAP * 1000 + 5000)
    expect(loopFor('c3')).toBeNull()
    expect(h.rounds.filter((r) => r.chatId === 'c3')).toHaveLength(LOOP_CAP)
  })

  it('stops quietly once the chat is gone', async () => {
    loopCommand('gone', '/loop 1m x')
    await vi.advanceTimersByTimeAsync(0)
    expect(loopFor('gone')).toBeNull()
    expect(h.rounds).toHaveLength(0)
  })
})
