import { describe, it, expect } from 'vitest'
import { quietRuns, type RowFacts } from './quiet-rounds'

const round: RowFacts = { user: true, round: true, idle: false }
const typed: RowFacts = { user: true, round: false, idle: false }
const idle: RowFacts = { user: false, round: false, idle: true }
const reply: RowFacts = { user: false, round: false, idle: false }

describe('quietRuns', () => {
  it('folds quiet rounds that sit next to each other into one run', () => {
    const rows = [round, idle, reply, round, idle, reply, round, idle, reply, round, reply]
    expect(quietRuns(rows)).toEqual([{ from: 0, to: 9, rounds: 3 }])
  })

  it('leaves a round that did something, and starts a new run after it', () => {
    const rows = [round, idle, reply, round, reply, reply, round, idle, reply, round, reply]
    expect(quietRuns(rows)).toEqual([
      { from: 0, to: 3, rounds: 1 },
      { from: 6, to: 9, rounds: 1 }
    ])
  })

  it('never folds the round at the end: it may still be running', () => {
    expect(quietRuns([round, idle, reply])).toEqual([])
    expect(quietRuns([round, idle, reply, round, idle])).toEqual([{ from: 0, to: 3, rounds: 1 }])
  })

  it('a message from the person ends a round and is never folded', () => {
    const rows = [round, idle, reply, typed, reply, round, idle, reply, typed]
    expect(quietRuns(rows)).toEqual([
      { from: 0, to: 3, rounds: 1 },
      { from: 5, to: 8, rounds: 1 }
    ])
  })

  it('finds nothing in a chat with no loop', () => {
    expect(quietRuns([typed, reply, typed, reply])).toEqual([])
  })
})
