import { describe, expect, it } from 'vitest'
import {
  autoCleanup,
  describeSimulators,
  IDLE_MS,
  sizeLabel,
  simulatorsToShutDown,
  simulatorsToSleep,
  SIM_IDLE_MS,
  type SleepContext,
  type PlanContext,
  type SimInfo
} from './sim-cleanup'

const NOW = Date.UTC(2026, 10, 19, 12)
const day = 24 * 60 * 60 * 1000
const dev = (udid: string, over: Partial<SimInfo> = {}): SimInfo => ({
  udid,
  name: udid,
  state: 'Shutdown',
  sizeBytes: 3e9,
  lastUsedAt: NOW - 10 * day,
  ...over
})
const ctx = (over: { held?: string[]; baseline?: string[] } = {}): PlanContext => ({
  now: NOW,
  held: new Set(over.held ?? []),
  baseline: new Set(over.baseline ?? [])
})

describe('autoCleanup', () => {
  it('removes a shut-down, unheld, new, week-old device', () => {
    expect(autoCleanup([dev('a')], ctx()).map((r) => r.udid)).toEqual(['a'])
  })
  it('never touches a running device', () => {
    expect(
      autoCleanup([dev('a', { state: 'Booted' }), dev('b', { state: 'Booting' })], ctx())
    ).toEqual([])
  })
  it('never touches one a conversation holds', () => {
    expect(autoCleanup([dev('a')], ctx({ held: ['a'] }))).toEqual([])
  })
  it("leaves the person's own (there at the first look) alone", () => {
    expect(autoCleanup([dev('a')], ctx({ baseline: ['a'] }))).toEqual([])
  })
  it('waits until it has been idle a week', () => {
    expect(autoCleanup([dev('a', { lastUsedAt: NOW - IDLE_MS + 1000 })], ctx())).toEqual([])
    expect(autoCleanup([dev('a', { lastUsedAt: NOW - IDLE_MS - 1000 })], ctx()).length).toBe(1)
    expect(autoCleanup([dev('a', { lastUsedAt: null })], ctx()).length).toBe(1)
  })
})

describe('describeSimulators', () => {
  it('lists biggest first and says why each is kept', () => {
    const rows = describeSimulators(
      [
        dev('small', { sizeBytes: 1e9 }),
        dev('big', { sizeBytes: 14e9, state: 'Booted' }),
        dev('mine', { sizeBytes: 5e9 }),
        dev('busy', { sizeBytes: 4e9 }),
        dev('fresh', { sizeBytes: 2e9, lastUsedAt: NOW - day })
      ],
      ctx({ baseline: ['mine'], held: ['busy'] })
    )
    expect(rows.map((r) => [r.udid, r.keep, r.removable])).toEqual([
      ['big', 'running', false],
      ['mine', 'baseline', true],
      ['busy', 'held', false],
      ['fresh', 'recent', true],
      ['small', null, true]
    ])
  })
  it('puts sizes in words', () => {
    expect(sizeLabel(14.3e9)).toBe('14 GB')
    expect(sizeLabel(3.24e9)).toBe('3.2 GB')
    expect(sizeLabel(820e6)).toBe('820 MB')
  })
})

describe('the simulators shut down when Superagent quits', () => {
  const a = '00000000-1111-2222-3333-444444444444'
  const b = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  it("takes every conversation's simulator once", () => {
    expect(simulatorsToShutDown([a, b], [a.toLowerCase()])).toEqual([a, b.toUpperCase()])
  })
  it('never anything that is not a UDID: they go on a command line', () => {
    expect(simulatorsToShutDown(['all', 'booted', `${a}; rm -rf ~`, '', a])).toEqual([a])
  })
})

describe('simulators left booted by conversations', () => {
  const A = 'AAAAAAAA-0000-0000-0000-000000000001'
  const B = 'AAAAAAAA-0000-0000-0000-000000000002'
  const MINE = 'AAAAAAAA-0000-0000-0000-000000000003'
  const NEW = 'AAAAAAAA-0000-0000-0000-000000000004'
  const ctx = (over: Partial<SleepContext> = {}): SleepContext => ({
    booted: [A, B, MINE, NEW],
    ownerOf: (u) => (u === A ? 'chat-a' : u === B ? 'chat-b' : null),
    baseline: new Set([A, B, MINE]),
    shown: new Set(),
    agentRunning: () => false,
    idleSince: new Map(),
    now: 0,
    ...over
  })
  it("shuts down a conversation's simulator only after it sat unused for the idle time", () => {
    const idleSince = new Map<string, number>()
    expect(simulatorsToSleep(ctx({ idleSince, now: 0 }))).toEqual([])
    expect(simulatorsToSleep(ctx({ idleSince, now: SIM_IDLE_MS - 1 }))).toEqual([])
    expect(simulatorsToSleep(ctx({ idleSince, now: SIM_IDLE_MS }))).toEqual([A, B, NEW])
  })
  it('never one the person started, one on screen, or one whose agent is working', () => {
    const idleSince = new Map<string, number>()
    const c = (now: number): string[] =>
      simulatorsToSleep(
        ctx({ idleSince, now, shown: new Set([B]), agentRunning: (id) => id === 'chat-a' })
      )
    c(0)
    // MINE (there at the first look, nobody's) is never on the list.
    expect(c(SIM_IDLE_MS * 2)).toEqual([NEW])
  })
  it('starts the wait over when it is used again in between', () => {
    const idleSince = new Map<string, number>()
    simulatorsToSleep(ctx({ idleSince, now: 0 }))
    simulatorsToSleep(ctx({ idleSince, now: 5, shown: new Set([A]) }))
    expect(simulatorsToSleep(ctx({ idleSince, now: SIM_IDLE_MS + 1 }))).not.toContain(A)
    expect(simulatorsToSleep(ctx({ idleSince, now: SIM_IDLE_MS * 2 + 5 }))).toContain(A)
  })
})
