import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'events'

const h = vi.hoisted(() => ({
  bus: null as unknown as EventEmitter,
  sessions: [] as { id: string; owned: boolean }[],
  stopped: [] as string[]
}))
vi.mock('../agent', async () => {
  const { EventEmitter: E } = await import('events')
  h.bus = new E()
  return {
    agentBus: h.bus,
    listSessions: () => h.sessions,
    stopAgent: (id: string) => h.stopped.push(id)
  }
})

const { startReaper } = await import('./reaper')

describe('the reaper for chats the phone started', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    h.sessions.length = 0
    h.stopped.length = 0
  })
  afterEach(() => vi.useRealTimers())

  it('leaves a session alone while its sub-agent works, however quiet', () => {
    startReaper()
    h.sessions.push({ id: 's1', owned: false }, { id: 's2', owned: false })
    h.bus.emit('started', { id: 's1' })
    h.bus.emit('started', { id: 's2' })
    h.bus.emit('event', {
      id: 's1',
      event: {
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'a', task_type: 'local_agent' }]
      }
    })
    vi.advanceTimersByTime(12 * 60_000)
    expect(h.stopped).toEqual(['s2'])
    // The agent finished: the next quiet ten minutes end it.
    h.bus.emit('event', {
      id: 's1',
      event: { type: 'system', subtype: 'background_tasks_changed', tasks: [] }
    })
    vi.advanceTimersByTime(12 * 60_000)
    expect(h.stopped).toEqual(['s2', 's1'])
  })
})
