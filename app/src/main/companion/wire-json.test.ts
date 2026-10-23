import { describe, expect, it } from 'vitest'
import { stringifyForPhone } from './wire-json'

describe('phone JSON', () => {
  it('repairs a persisted tool summary truncated halfway through an emoji', () => {
    const summary = ('a'.repeat(399) + '😀').slice(0, 400)
    const stored = JSON.parse(JSON.stringify({ kind: 'tool_result', summary }))
    const encoded = stringifyForPhone({ t: 'event', event: { seq: 2515, data: stored } })
    expect(JSON.parse(encoded).event.data.summary).toBe('a'.repeat(399) + '�')
    expect(encoded).not.toContain('\\ud83d')
  })

  it('keeps intact emoji, escapes and multilingual text unchanged', () => {
    const frame = { text: '😀 👩🏽‍💻 中文 ü \\ud83d', nested: ['🚀', '\uDC00', '\uD800\uD800'] }
    expect(JSON.parse(stringifyForPhone(frame))).toEqual({
      text: frame.text,
      nested: ['🚀', '�', '��']
    })
  })
})
