import { describe, expect, it } from 'vitest'
import { loadSealed, type Seal } from './sealed-settings'

// A seal that only "opens" what it closed itself.
const seal: Seal = {
  close: (t) => `sealed:${Buffer.from(t).toString('base64')}`,
  open: (b) => (b.startsWith('sealed:') ? Buffer.from(b.slice(7), 'base64').toString() : null)
}
const none = (): null => null

describe("computer use's settings, sealed", () => {
  it('come back as they were saved', () => {
    const saved = { 'computer.enabled': '1', 'computer.denied': '[{"id":"a","name":"A"}]' }
    expect(loadSealed(seal.close(JSON.stringify(saved)), none, seal)).toEqual(saved)
  })

  it('are nothing at all when the blob does not open, whatever the plain rows say', () => {
    const plain = (k: string): string | null => (k === 'computer.enabled' ? '1' : null)
    expect(loadSealed('written by someone else', plain, seal)).toEqual({})
    expect(loadSealed(seal.close('not json'), plain, seal)).toEqual({})
    expect(loadSealed(seal.close('[1,2]'), plain, seal)).toEqual({})
  })

  it('carry over from an earlier version only what makes it more careful', () => {
    const rows: Record<string, string> = {
      'computer.enabled': '1',
      'computer.ring': '0',
      'computer.steps': '1',
      'computer.focused': '1',
      'computer.denied': '[{"id":"com.tinyspeck.slackmacgap","name":"Slack"}]',
      'computer.rules':
        '[{"id":"com.apple.mail","name":"Mail","level":"look"},{"id":"com.apple.Terminal","name":"Terminal","level":"allow"}]'
    }
    expect(loadSealed(null, (k) => rows[k] ?? null, seal)).toEqual({
      'computer.steps': '1',
      'computer.focused': '1',
      'computer.denied': rows['computer.denied'],
      'computer.rules': '[{"id":"com.apple.mail","name":"Mail","level":"look"}]'
    })
    // Rows that are not what they should be are simply not taken.
    expect(
      loadSealed(
        null,
        (k) => ({ 'computer.denied': '{"x":1}', 'computer.rules': 'nonsense' })[k] ?? null,
        seal
      )
    ).toEqual({})
  })
})
