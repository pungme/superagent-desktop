import { describe, it, expect } from 'vitest'
import { visibleTimeIds, TIME_GROUP_GAP_MS } from './message-time-groups'

interface Msg {
  id: string
  at: number | null
}
const at = (m: Msg): number | null => m.at

describe('visibleTimeIds', () => {
  it('shows the timestamp of a lone message', () => {
    const ids = visibleTimeIds([{ id: 'a', at: 1000 }], at)
    expect(ids).toEqual(new Set(['a']))
  })

  it('collapses an earlier message sent right before the next one', () => {
    const msgs = [
      { id: 'a', at: 0 },
      { id: 'b', at: 1000 } // well under the gap
    ]
    expect(visibleTimeIds(msgs, at)).toEqual(new Set(['b']))
  })

  it('keeps both timestamps when the gap exceeds the threshold', () => {
    const msgs = [
      { id: 'a', at: 0 },
      { id: 'b', at: TIME_GROUP_GAP_MS + 1 }
    ]
    expect(visibleTimeIds(msgs, at)).toEqual(new Set(['a', 'b']))
  })

  it('collapses a whole burst down to just the last one', () => {
    const msgs = [
      { id: 'a', at: 0 },
      { id: 'b', at: 1000 },
      { id: 'c', at: 2000 },
      { id: 'd', at: 3000 }
    ]
    expect(visibleTimeIds(msgs, at)).toEqual(new Set(['d']))
  })

  it('skips messages with no resolvable timestamp (e.g. still streaming)', () => {
    const msgs = [
      { id: 'a', at: 0 },
      { id: 'b', at: null }
    ]
    expect(visibleTimeIds(msgs, at)).toEqual(new Set(['a']))
  })

  it('treats the boundary gap itself as still clustered', () => {
    const msgs = [
      { id: 'a', at: 0 },
      { id: 'b', at: TIME_GROUP_GAP_MS }
    ]
    expect(visibleTimeIds(msgs, at)).toEqual(new Set(['b']))
  })
})
