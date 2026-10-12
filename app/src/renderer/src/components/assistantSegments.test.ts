import { describe, it, expect } from 'vitest'
import { splitAssistant } from './assistantSegments'

/**
 * The parser behind the clickable choices Claude can offer. It lived in the
 * component file until the two were separated, and had no test of its own —
 * the streaming case especially, which is the one that shows the user raw JSON
 * if it goes wrong.
 */
describe('splitAssistant', () => {
  const ask = (o: unknown): string => '```ask\n' + JSON.stringify(o) + '\n```'
  const spec = { question: 'Which theme?', options: [{ label: 'Dark' }, { label: 'Light' }] }

  it('leaves a message with no block as one run of prose', () => {
    expect(splitAssistant('just words')).toEqual([{ md: 'just words' }])
  })

  it('pulls a block out from between the prose around it', () => {
    const segs = splitAssistant(`before\n${ask(spec)}\nafter`)
    expect(segs).toHaveLength(3)
    expect(segs[0]).toEqual({ md: 'before\n' })
    expect(segs[1]).toEqual({ ask: spec })
    expect(segs[2]).toEqual({ md: '\nafter' })
  })

  it('hides a block that is still streaming, rather than flashing its JSON', () => {
    const half = '```ask\n{"question":"Which th'
    expect(splitAssistant(`text\n${half}`)).toEqual([{ md: 'text\n' }])
  })

  it('keeps a malformed block as prose instead of dropping it', () => {
    const bad = '```ask\n{not json}\n```'
    const segs = splitAssistant(bad)
    expect(segs.every((s) => 'md' in s)).toBe(true)
    expect(segs.map((s) => ('md' in s ? s.md : '')).join('')).toContain('not json')
  })

  it('repairs an ask payload missing its final object brace', () => {
    const truncated =
      '```ask\n' +
      '{"question":"Was that the right episode?","multiple":false,"options":[' +
      '{"label":"Yes, S1E2"},{"label":"I meant S2E2"}]\n```'
    expect(splitAssistant(truncated)).toEqual([
      {
        ask: {
          question: 'Was that the right episode?',
          multiple: false,
          options: [{ label: 'Yes, S1E2' }, { label: 'I meant S2E2' }]
        }
      }
    ])
  })

  it('does not repair mismatched delimiters or an unterminated string', () => {
    const malformed = [
      '```ask\n{"options":[{"label":"Dark"}]}]\n```',
      '```ask\n{"options":[{"label":"Dark}]\n```'
    ]
    for (const block of malformed) {
      const segs = splitAssistant(block)
      expect(segs.every((s) => 'md' in s)).toBe(true)
    }
  })

  it('handles more than one block in a single message', () => {
    const segs = splitAssistant(`${ask(spec)}mid${ask(spec)}`)
    expect(segs.filter((s) => 'ask' in s)).toHaveLength(2)
  })
})
