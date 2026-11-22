import { describe, it, expect } from 'vitest'
import { agyGroup, agyFallback, agyRunModel } from './agy-fallback'

const lineUp = [
  'gemini-4-neon-high',
  'gemini-4-neon-low',
  'gemini-4-argon-high',
  'gemini-4-argon-low',
  'claude-opus-5-5-high',
  'gpt-oss-120b-medium'
]

describe('Antigravity model fallback', () => {
  it('one quota per model, whatever the effort', () => {
    expect(agyGroup('gemini-4-neon-xhigh')).toBe('gemini-4-neon')
    expect(agyGroup('gemini-pro-orchestrator-neon')).toBe('gemini-pro-orchestrator-neon')
  })

  it('moves to the next model that is not out, at the same effort where it can', () => {
    const out = new Set(['gemini-4-neon'])
    expect(agyFallback('gemini-4-neon-low', lineUp, (g) => out.has(g))).toBe('gemini-4-argon-low')
    out.add('gemini-4-argon')
    expect(agyFallback('gemini-4-neon-low', lineUp, (g) => out.has(g))).toBe('claude-opus-5-5-high')
    out.add('claude-opus-5-5').add('gpt-oss-120b')
    expect(agyFallback('gemini-4-neon-low', lineUp, (g) => out.has(g))).toBeNull()
  })

  it('a chat starts on its pick until that is out; Default goes by what it turned out to be', () => {
    const out = new Set(['gemini-4-neon'])
    expect(agyRunModel('claude-opus-5-5-high', undefined, lineUp, (g) => out.has(g))).toBe(
      'claude-opus-5-5-high'
    )
    expect(agyRunModel('gemini-4-neon-high', undefined, lineUp, (g) => out.has(g))).toBe(
      'gemini-4-argon-high'
    )
    expect(agyRunModel(undefined, 'gemini-4-neon-high', lineUp, (g) => out.has(g))).toBe(
      'gemini-4-argon-high'
    )
    expect(agyRunModel(undefined, undefined, lineUp, (g) => out.has(g))).toBeUndefined()
  })
})
