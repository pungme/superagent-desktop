import { describe, it, expect } from 'vitest'
import {
  checkStuck,
  clockSeconds,
  descendants,
  parsePs,
  stepProcesses,
  STUCK_AFTER_MS,
  type ProcRow,
  type Samples
} from './stuck-step'

const MIN = 60_000

describe('reading ps', () => {
  it('reads elapsed and cpu clocks', () => {
    expect(clockSeconds('00:05')).toBe(5)
    expect(clockSeconds('12:34')).toBe(754)
    expect(clockSeconds('06:27:01')).toBe(6 * 3600 + 27 * 60 + 1)
    expect(clockSeconds('2-03:00:00')).toBe(2 * 86400 + 3 * 3600)
    expect(clockSeconds('0:00.42')).toBeCloseTo(0.42)
    expect(clockSeconds('nonsense')).toBeNull()
  })

  it('parses rows, commands with spaces kept whole', () => {
    const rows = parsePs(
      [
        '45131 41822 06:27:01 0:00.13 find /Users/me/Library/Mobile Documents -iname *Mr Market*',
        '41822  3860 06:30:03 0:42.10 /Users/me/.local/bin/agy --input-format stream-json',
        'garbage line'
      ].join('\n')
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ pid: 45131, ppid: 41822, cpu: 0.13 })
    expect(rows[0].command).toBe('find /Users/me/Library/Mobile Documents -iname *Mr Market*')
  })
})

describe('the step’s processes', () => {
  const row = (pid: number, ppid: number, elapsed: number, cpu = 0, command = 'x'): ProcRow => ({
    pid,
    ppid,
    elapsed,
    cpu,
    command
  })
  const rows = [
    row(10, 1, 9999, 50, 'agent'),
    row(11, 10, 9999, 1, 'mcp server'), // started with the agent
    row(12, 10, 300, 0, 'zsh -c find …'), // the step's shell
    row(13, 12, 299, 0, 'find /Users/me'),
    row(20, 1, 300, 0, 'someone else')
  ]

  it('finds everything under the agent, at any depth', () => {
    expect(
      descendants(rows, 10)
        .map((r) => r.pid)
        .sort()
    ).toEqual([11, 12, 13])
  })

  it('leaves out what the agent started before the step', () => {
    const now = 1_000_000
    const since = now - 300_000
    expect(
      stepProcesses(rows, 10, since, now)
        .map((r) => r.pid)
        .sort()
    ).toEqual([12, 13])
  })
})

describe('checkStuck', () => {
  const agent = (cpu: number): ProcRow => ({
    pid: 10,
    ppid: 1,
    elapsed: 99999,
    cpu,
    command: 'agy'
  })
  const find = (elapsed: number, cpu: number): ProcRow => ({
    pid: 13,
    ppid: 10,
    elapsed,
    cpu,
    command: 'find /Users/me/Library/Mobile Documents -iname *Mr Market*'
  })

  it('calls a step stuck once nothing has used CPU for ten minutes', () => {
    const samples: Samples = new Map()
    const since = 0
    // First look at 5 min: nothing to compare with yet.
    expect(checkStuck([agent(5), find(300, 0.1)], 10, since, 5 * MIN, samples)).toBeNull()
    // 14 min: idle for 9 min since the first look.
    expect(checkStuck([agent(5), find(840, 0.1)], 10, since, 14 * MIN, samples)).toBeNull()
    // 16 min: idle 11 min.
    const stuck = checkStuck([agent(5), find(960, 0.1)], 10, since, 16 * MIN, samples)
    expect(stuck).toMatchObject({ pids: [13], idleSince: 5 * MIN })
    expect(stuck!.command).toContain('Mr Market')
  })

  it('a step that keeps working is never stuck', () => {
    const samples: Samples = new Map()
    for (let m = 1; m <= 60; m++)
      expect(checkStuck([agent(5), find(m * 60, m * 2)], 10, 0, m * MIN, samples)).toBeNull()
  })

  it('an agent that is still thinking is not stuck, whatever its tool does', () => {
    const samples: Samples = new Map()
    for (let m = 1; m <= 30; m++)
      expect(checkStuck([agent(m * 3), find(m * 60, 0)], 10, 0, m * MIN, samples)).toBeNull()
  })

  it('work after a long pause starts the clock again', () => {
    const samples: Samples = new Map()
    checkStuck([agent(5), find(60, 0)], 10, 0, 1 * MIN, samples)
    checkStuck([agent(5), find(600, 3)], 10, 0, 10 * MIN, samples) // it moved
    expect(checkStuck([agent(5), find(1080, 3)], 10, 0, 18 * MIN, samples)).toBeNull()
    expect(checkStuck([agent(5), find(1260, 3)], 10, 0, 21 * MIN, samples)).not.toBeNull()
  })

  it('says nothing when the step has no process of its own (a tool inside the agent)', () => {
    const samples: Samples = new Map()
    for (let m = 1; m <= 30; m++) expect(checkStuck([agent(5)], 10, 0, m * MIN, samples)).toBeNull()
  })

  it('forgets processes that ended', () => {
    const samples: Samples = new Map()
    checkStuck([agent(5), find(60, 0)], 10, 0, MIN, samples)
    expect(samples.has(13)).toBe(true)
    checkStuck([agent(5)], 10, 0, 2 * MIN, samples)
    expect(samples.has(13)).toBe(false)
  })

  it('waits the full time from the step’s start even when first seen late', () => {
    const samples: Samples = new Map()
    expect(STUCK_AFTER_MS).toBe(10 * MIN)
    // First looked at long after the step began: still needs ten idle minutes of looking.
    expect(checkStuck([agent(5), find(3600, 0)], 10, 0, 60 * MIN, samples)).toBeNull()
    expect(checkStuck([agent(5), find(4260, 0)], 10, 0, 71 * MIN, samples)).not.toBeNull()
  })
})
