import { describe, it, expect } from 'vitest'
import { mergeTranscripts } from './transcript-merge'

const msg = (id: string, text = id): { kind: string; msg: { id: string; text: string } } => ({
  kind: 'msg',
  msg: { id, text }
})

describe('putting the window’s copy and the stored one together', () => {
  it('keeps what the phone added and what only the window has', () => {
    const stored = [msg('a'), msg('b'), msg('phone-1'), msg('phone-2')]
    const local = [msg('a'), msg('b'), msg('streaming', 'half an answer')]
    expect(mergeTranscripts(stored, local).map((i) => i.msg.id)).toEqual([
      'a',
      'b',
      'phone-1',
      'phone-2',
      'streaming'
    ])
  })

  it('the window’s edit of an item both hold wins', () => {
    const stored = [msg('a', 'old')]
    const local = [msg('a', 'edited')]
    expect(mergeTranscripts(stored, local)[0].msg.text).toBe('edited')
  })

  it('does not double an item it already has', () => {
    const both = [msg('a'), msg('b')]
    expect(mergeTranscripts(both, both)).toHaveLength(2)
  })

  it('items of other kinds are matched by their own ids', () => {
    const tool = { kind: 'tool', tool: { id: 't1' } }
    const thinking = { kind: 'thinking', id: 'k1', text: 'hm' }
    const out = mergeTranscripts([tool], [tool, thinking])
    expect(out).toHaveLength(2)
  })
})
