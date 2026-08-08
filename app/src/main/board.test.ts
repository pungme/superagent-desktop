import { describe, it, expect } from 'vitest'
import { normalizeStatus, positionBetween } from './store'

describe('normalizeStatus', () => {
  it('accepts the four columns as written', () => {
    expect(normalizeStatus('backlog')).toBe('backlog')
    expect(normalizeStatus('todo')).toBe('todo')
    expect(normalizeStatus('doing')).toBe('doing')
    expect(normalizeStatus('done')).toBe('done')
  })

  it('accepts the words an agent would plausibly reach for instead', () => {
    expect(normalizeStatus('in_progress')).toBe('doing')
    expect(normalizeStatus('in progress')).toBe('doing')
    expect(normalizeStatus('In-Progress')).toBe('doing')
    expect(normalizeStatus('WIP')).toBe('doing')
    expect(normalizeStatus('completed')).toBe('done')
    expect(normalizeStatus('Complete')).toBe('done')
    expect(normalizeStatus('to do')).toBe('todo')
    expect(normalizeStatus('next')).toBe('todo')
  })

  it('never drops a card: anything unrecognised is backlog', () => {
    // The agent writes these — a typo must not make a card disappear.
    expect(normalizeStatus('blocked')).toBe('backlog')
    expect(normalizeStatus('')).toBe('backlog')
    expect(normalizeStatus(undefined)).toBe('backlog')
    expect(normalizeStatus(null)).toBe('backlog')
    expect(normalizeStatus(42)).toBe('backlog')
  })
})

describe('positionBetween', () => {
  it('seeds an empty column', () => {
    expect(positionBetween(null, null)).toBe(1000)
  })

  it('appends after the last card and prepends before the first', () => {
    expect(positionBetween(1000, null)).toBe(2000)
    expect(positionBetween(null, 1000)).toBe(0)
  })

  it('lands strictly between two neighbours', () => {
    const p = positionBetween(1000, 2000)
    expect(p).toBeGreaterThan(1000)
    expect(p).toBeLessThan(2000)
  })

  it('keeps splitting the same gap without collapsing onto a neighbour', () => {
    // Repeated drops into one slot are the case that would break ordering.
    let lo = 1000
    const hi = 2000
    for (let i = 0; i < 20; i++) {
      const p = positionBetween(lo, hi)
      expect(p).toBeGreaterThan(lo)
      expect(p).toBeLessThan(hi)
      lo = p
    }
  })

  it('orders correctly for negative positions, which prepending produces', () => {
    const first = positionBetween(null, 0)
    expect(first).toBeLessThan(0)
    expect(positionBetween(first, 0)).toBeGreaterThan(first)
  })
})
