import { describe, expect, it } from 'vitest'
import { autoCleanup, describeSimulators, IDLE_MS, sizeLabel, type SimInfo } from './sim-cleanup'

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
const ctx = (over: { held?: string[]; baseline?: string[] } = {}) => ({
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
