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
  pauseLoop,
  registerLoops,
  requestLoopWait,
  agentIdleLoop,
  setUnattendedSend,
  _resetLoopsForTests
} from './loops'
import { LOOP_STOP_NOTE, parseLoopCmd, quietGapMs, SELF_PACE_NOTE } from '../shared/loop'

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
    expect(parseLoopCmd('/loop pause')).toEqual({ kind: 'pause' })
    expect(parseLoopCmd('/loop resume')).toEqual({ kind: 'resume' })
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
    expect(h.rounds.map((r) => r.text)).toEqual(['check prices' + LOOP_STOP_NOTE])
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
    expect(h.sendToAgent).toHaveBeenCalledWith('s1', 'ping' + LOOP_STOP_NOTE, [], {
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
    expect(unattended).toHaveBeenCalledWith('c1', 'ping' + LOOP_STOP_NOTE)
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

    // No cap: a loop runs until it is stopped.
    loopCommand('c3', '/loop 1s c')
    await vi.advanceTimersByTimeAsync(300 * 1000 + 500)
    expect(loopFor('c3')).not.toBeNull()
    expect(h.rounds.filter((r) => r.chatId === 'c3').length).toBeGreaterThan(250)
  })

  it('stops quietly once the chat is gone', async () => {
    loopCommand('gone', '/loop 1m x')
    await vi.advanceTimersByTimeAsync(0)
    expect(loopFor('gone')).toBeNull()
    expect(h.rounds).toHaveLength(0)
  })

  it('pause holds the next round and resume picks it up, for a self-paced loop', async () => {
    loopCommand('c1', '/loop tidy up')
    await vi.advanceTimersByTimeAsync(0)
    turn('c1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(loopCommand('c1', '/loop pause')).toMatch(/paused/)
    expect(loopFor('c1')).toMatchObject({ paused: true, nextAt: null, count: 1 })
    // Long past when the next round was due: nothing goes out.
    await vi.advanceTimersByTimeAsync(600_000)
    expect(h.rounds).toHaveLength(1)
    expect(loopCommand('c1', '/loop resume')).toMatch(/resumed/)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.rounds).toHaveLength(2)
    expect(loopFor('c1')).toMatchObject({ paused: false, count: 2 })
  })

  it('paused mid-round, the round finishes and the next one waits for resume', async () => {
    loopCommand('c1', '/loop tidy up')
    await vi.advanceTimersByTimeAsync(0)
    h.generating.add('c1')
    h.logBus.emit('busy', { chatId: 'c1' })
    pauseLoop('c1', true)
    h.generating.delete('c1')
    h.logBus.emit('busy', { chatId: 'c1' })
    await vi.advanceTimersByTimeAsync(120_000)
    expect(h.rounds).toHaveLength(1)
    pauseLoop('c1', false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(h.rounds).toHaveLength(2)
  })

  it('an interval loop skips its ticks while paused and keeps its beat after', async () => {
    loopCommand('c1', '/loop 5m check prices')
    await vi.advanceTimersByTimeAsync(0)
    pauseLoop('c1', true)
    await vi.advanceTimersByTimeAsync(900_000)
    expect(h.rounds).toHaveLength(1)
    expect(loopFor('c1')).toMatchObject({ paused: true, nextAt: null })
    pauseLoop('c1', false)
    expect(loopFor('c1')?.nextAt).toBeTypeOf('number')
    await vi.advanceTimersByTimeAsync(300_000)
    expect(h.rounds).toHaveLength(2)
  })

  it('pause and resume with no loop say so', () => {
    expect(loopCommand('c9', '/loop pause')).toMatch(/No loop/)
    expect(loopCommand('c9', '/loop resume')).toMatch(/No loop/)
  })

  /** A round of a loop as the agent sees it: the turn runs, maybe says it was idle, ends. */
  async function round(chatId: string, idle: boolean): Promise<void> {
    h.generating.add(chatId)
    h.logBus.emit('busy', { chatId })
    if (idle) agentIdleLoop(chatId, 'checked everything, nothing left', false)
    h.generating.delete(chatId)
    h.logBus.emit('busy', { chatId })
    await vi.advanceTimersByTimeAsync(0)
  }

  it('waits a minute, then five, fifteen, thirty and an hour', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(quietGapMs)).toEqual([
      0, 60_000, 300_000, 900_000, 1_800_000, 3_600_000, 3_600_000
    ])
  })

  /** The agent cannot end a loop; a round with nothing in it makes the next one later. */
  it('waits longer after each quiet round and never ends by itself', async () => {
    loopCommand('c1', '/loop keep polishing')
    await vi.advanceTimersByTimeAsync(0)
    expect(h.rounds).toHaveLength(1)

    await round('c1', true)
    expect(loopFor('c1')).toMatchObject({ quiet: 1 })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(h.rounds).toHaveLength(2)

    // A second quiet round in a row: five minutes, not one.
    await round('c1', true)
    expect(loopFor('c1')).toMatchObject({ quiet: 2 })
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(h.rounds).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(h.rounds).toHaveLength(3)

    // Many more: still running, each after its own wait, an hour at the most.
    for (let i = 0; i < 6; i++) {
      await round('c1', true)
      await vi.advanceTimersByTimeAsync(quietGapMs(3 + i) - 1000)
      expect(h.rounds).toHaveLength(3 + i)
      await vi.advanceTimersByTimeAsync(2000)
    }
    expect(loopFor('c1')).not.toBeNull()
    expect(h.rounds).toHaveLength(9)
  })

  it('goes back to the short wait once a round does something', async () => {
    loopCommand('c1', '/loop keep polishing')
    await vi.advanceTimersByTimeAsync(0)
    await round('c1', true)
    await vi.advanceTimersByTimeAsync(61_000)
    await round('c1', true)
    await vi.advanceTimersByTimeAsync(301_000)
    expect(h.rounds).toHaveLength(3)
    // This round worked.
    await round('c1', false)
    expect(loopFor('c1')).toMatchObject({ quiet: 0 })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(h.rounds).toHaveLength(4)
  })

  it('goes back to the short wait when the person writes', async () => {
    loopCommand('c1', '/loop keep polishing')
    await vi.advanceTimersByTimeAsync(0)
    for (const wait of [61_000, 301_000, 901_000]) {
      await round('c1', true)
      await vi.advanceTimersByTimeAsync(wait)
    }
    await round('c1', true)
    expect(loopFor('c1')).toMatchObject({ quiet: 4 })
    const sent = h.rounds.length
    // A round's own message is not the person writing.
    h.agentBus.emit('user', { chatId: 'c1', text: 'keep polishing' + SELF_PACE_NOTE })
    expect(loopFor('c1')).toMatchObject({ quiet: 4 })
    // They write; that turn runs and ends; the next round is a minute away, not thirty.
    h.agentBus.emit('user', { chatId: 'c1', text: 'the header is still off' })
    expect(loopFor('c1')).toMatchObject({ quiet: 0 })
    await round('c1', false)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(h.rounds).toHaveLength(sent + 1)
  })

  it('an interval loop sits out its ticks after quiet rounds', async () => {
    loopCommand('c1', '/loop 1m check the queue')
    await vi.advanceTimersByTimeAsync(0)
    await round('c1', true)
    await vi.advanceTimersByTimeAsync(60_000)
    await round('c1', true)
    const sent = h.rounds.length
    // Five minutes of quiet wait: the one-minute ticks in between are skipped.
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(h.rounds).toHaveLength(sent)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(h.rounds).toHaveLength(sent + 1)
  })

  it('is held when the agent needs the person, and goes on when they reply', async () => {
    loopCommand('c1', '/loop ship the fix')
    await vi.advanceTimersByTimeAsync(0)
    h.generating.add('c1')
    h.logBus.emit('busy', { chatId: 'c1' })
    expect(agentIdleLoop('c1', 'I need the   App Store password.', true)).toEqual({
      state: 'needs-user'
    })
    h.generating.delete('c1')
    h.logBus.emit('busy', { chatId: 'c1' })
    expect(loopFor('c1')).toMatchObject({ paused: true, needsUser: true })
    expect(h.record).toHaveBeenCalledWith('c1', {
      kind: 'notice',
      text: expect.stringMatching(/waiting for you: I need the App Store password\./)
    })
    await vi.advanceTimersByTimeAsync(3 * 3_600_000)
    expect(h.rounds).toHaveLength(1)

    h.agentBus.emit('user', { chatId: 'c1', text: 'it is in 1Password' })
    expect(loopFor('c1')).toMatchObject({ paused: false, needsUser: false })
    await round('c1', false)
    await vi.advanceTimersByTimeAsync(61_000)
    expect(h.rounds).toHaveLength(2)
  })

  it('tells the agent when there is no loop to be idle in', () => {
    expect(agentIdleLoop('c9', 'nothing', false)).toEqual({ state: 'none' })
  })

  it("tells the agent when there's no loop to wait for", async () => {
    // The user stopped it; the agent still remembers the loop and asks for a wait.
    loopCommand('c1', '/loop tidy up')
    await vi.advanceTimersByTimeAsync(0)
    loopCommand('c1', '/loop stop')
    expect(requestLoopWait('c1', 360)).toBe('none')
    loopCommand('c2', '/loop 5m check')
    expect(requestLoopWait('c2', 360)).toBe('interval')
    loopCommand('c3', '/loop tidy')
    expect(requestLoopWait('c3', 360)).toBe('set')
    pauseLoop('c3', true)
    expect(requestLoopWait('c3', 360)).toBe('paused')
  })
})
