import { describe, it, expect } from 'vitest'
import {
  attentionOrder,
  compactTokens,
  runsPerWeek,
  savingsFor,
  typicalRunTokens,
  weeklyTokens
} from './routine-cost'

const HOUR = 3_600_000
const ok = (tokens: number): { status: string; tokens: number } => ({ status: 'ok', tokens })

describe('routine cost', () => {
  it('has no estimate before a run was measured', () => {
    expect(typicalRunTokens([])).toBeNull()
    expect(typicalRunTokens([ok(0)])).toBeNull()
    expect(weeklyTokens([], HOUR)).toBeNull()
  })

  it('takes the typical run from the latest runs, newest first', () => {
    const runs = [ok(10_000), ok(20_000), ok(30_000), ok(40_000), ok(50_000), ok(900_000)]
    // The sixth and oldest run is left out.
    expect(typicalRunTokens(runs)).toBe(30_000)
  })

  it('skips runs that used nothing (a start that failed)', () => {
    expect(typicalRunTokens([ok(0), ok(8_000), ok(0), ok(12_000)])).toBe(10_000)
  })

  it('counts the runs in a week from the interval', () => {
    expect(runsPerWeek(HOUR)).toBe(168)
    expect(runsPerWeek(24 * HOUR)).toBe(7)
    expect(runsPerWeek(0)).toBe(0)
  })

  it('multiplies the typical run by the runs in a week', () => {
    expect(weeklyTokens([ok(10_000)], HOUR)).toBe(1_680_000)
    expect(weeklyTokens([ok(10_000)], 24 * HOUR)).toBe(70_000)
  })

  it('costs nothing a week while paused', () => {
    expect(weeklyTokens([ok(10_000)], HOUR, false)).toBe(0)
  })

  it('shows what a slower interval saves', () => {
    const s = savingsFor([ok(10_000)], HOUR, 6 * HOUR)!
    expect(s.before).toBe(1_680_000)
    expect(s.after).toBe(280_000)
    expect(s.saved).toBe(1_400_000)
    expect(savingsFor([], HOUR, 6 * HOUR)).toBeNull()
  })

  it('writes tokens short', () => {
    expect(compactTokens(850)).toBe('850')
    expect(compactTokens(1_500)).toBe('1.5k')
    expect(compactTokens(42_000)).toBe('42k')
    expect(compactTokens(1_680_000)).toBe('1.7M')
    expect(compactTokens(2_000_000)).toBe('2M')
  })

  it('puts failed runs first, then running, then by next run, paused last', () => {
    const r = (id: string, s: string | null, next: number, enabled = 1) => ({
      id,
      lastRunStatus: s,
      nextRunAt: next,
      enabled
    })
    const sorted = attentionOrder([
      r('paused', 'ok', 1, 0),
      r('later', 'ok', 30),
      r('failed', 'error', 50),
      r('soon', 'ok', 10),
      r('running', 'running', 5)
    ]).map((x) => x.id)
    expect(sorted).toEqual(['failed', 'running', 'soon', 'later', 'paused'])
  })
})
