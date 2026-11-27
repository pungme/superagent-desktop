import { describe, it, expect } from 'vitest'
import { itemKeys, mergeTranscripts } from './transcript-merge'

const msg = (id: string, text = id): { kind: string; msg: { id: string; text: string } } => ({
  kind: 'msg',
  msg: { id, text }
})
const ids = (xs: { msg: { id: string } }[]): string[] => xs.map((i) => i.msg.id)

describe('putting the window’s copy and the stored one together', () => {
  it('keeps what the phone added and what only the window has', () => {
    const base = itemKeys([msg('a'), msg('b')])
    const stored = [msg('a'), msg('b'), msg('phone-1'), msg('phone-2')]
    const local = [msg('a'), msg('b'), msg('streaming', 'half an answer')]
    expect(ids(mergeTranscripts(stored, local, base))).toEqual([
      'a',
      'b',
      'streaming',
      'phone-1',
      'phone-2'
    ])
  })

  it('the window’s edit of an item both hold wins', () => {
    const base = itemKeys([msg('a', 'old')])
    const out = mergeTranscripts([msg('a', 'old'), msg('p')], [msg('a', 'edited')], base)
    expect(out[0].msg.text).toBe('edited')
    expect(ids(out)).toEqual(['a', 'p'])
  })

  it('an item the window deleted stays deleted', () => {
    const base = itemKeys([msg('a'), msg('b'), msg('c')])
    // Rewound to before b; the phone then added p.
    const out = mergeTranscripts([msg('a'), msg('b'), msg('c'), msg('p')], [msg('a')], base)
    expect(ids(out)).toEqual(['a', 'p'])
  })

  it('a conversation cleared elsewhere is not brought back', () => {
    const base = itemKeys([msg('a'), msg('b')])
    const out = mergeTranscripts([], [msg('a'), msg('b'), msg('new')], base)
    expect(ids(out)).toEqual(['new'])
  })

  it('does not double an item it already has', () => {
    const both = [msg('a'), msg('b')]
    expect(mergeTranscripts(both, both, itemKeys([]))).toHaveLength(2)
  })

  it('items of other kinds are matched by their own ids', () => {
    const tool = { kind: 'tool', tool: { id: 't1' } }
    const thinking = { kind: 'thinking', id: 'k1', text: 'hm' }
    const out = mergeTranscripts([tool, thinking], [tool], itemKeys([tool]))
    expect(out).toHaveLength(2)
  })
})
