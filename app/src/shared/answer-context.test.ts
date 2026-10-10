import { describe, expect, it } from 'vitest'
import { answerNeedsQuestion } from './answer-context'

const said = (...m: [string, 'user' | 'assistant'][]): { id: string; role: 'user' | 'assistant' }[] =>
  m.map(([id, role]) => ({ id, role }))

describe('an option picked from a question', () => {
  it('goes bare while the question is the last thing said and the agent waits', () => {
    expect(answerNeedsQuestion(said(['u1', 'user'], ['a1', 'assistant']), 'a1', false)).toBe(false)
  })
  it('carries the question once the agent has said something newer', () => {
    expect(
      answerNeedsQuestion(said(['a1', 'assistant'], ['u1', 'user'], ['a2', 'assistant']), 'a1', false)
    ).toBe(true)
  })
  it('carries it when the user has written since, though no newer reply exists', () => {
    expect(answerNeedsQuestion(said(['a1', 'assistant'], ['u1', 'user']), 'a1', false)).toBe(true)
  })
  it('carries it while the agent is at work on something else', () => {
    expect(answerNeedsQuestion(said(['a1', 'assistant']), 'a1', true)).toBe(true)
  })
})
