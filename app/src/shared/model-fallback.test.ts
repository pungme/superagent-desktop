import { describe, it, expect } from 'vitest'
import { fallbackModelFor, fallbackNotice, modelFallbackFrom, prettyModel } from './model-fallback'

describe('model fallback', () => {
  it('steps down one model, and not below Sonnet', () => {
    expect(fallbackModelFor('')).toBe('opus')
    expect(fallbackModelFor(undefined)).toBe('opus')
    expect(fallbackModelFor('claude-fable-5-1')).toBe('opus')
    expect(fallbackModelFor('claude-fable-5-1[1m]')).toBe('opus')
    expect(fallbackModelFor('opus')).toBe('sonnet')
    expect(fallbackModelFor('claude-opus-4-8')).toBe('sonnet')
    expect(fallbackModelFor('sonnet')).toBeNull()
    expect(fallbackModelFor('haiku')).toBeNull()
  })

  it('names models the way the picker does', () => {
    expect(prettyModel('claude-fable-5-1[1m]')).toBe('Fable 5.1')
    expect(prettyModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(prettyModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(prettyModel('claude-fable-5-20260115')).toBe('Fable 5')
    expect(prettyModel('opus')).toBe('Opus')
    expect(prettyModel('gpt-5.6-codex')).toBe('gpt-5.6-codex')
  })

  it("reads the CLI's model_fallback event and says it in one line", () => {
    const f = modelFallbackFrom({
      type: 'system',
      subtype: 'model_fallback',
      trigger: 'last_resort',
      original_model: 'claude-fable-5-1',
      fallback_model: 'claude-opus-5-5'
    })
    expect(f).toEqual({
      original: 'claude-fable-5-1',
      fallback: 'claude-opus-5-5',
      trigger: 'last_resort'
    })
    expect(fallbackNotice(f!)).toBe(
      "↻ Fable 5.1 isn't available right now (its allowance may be used up) — continuing on Opus 5.5. It goes back to Fable 5.1 as soon as it can."
    )
    expect(fallbackNotice({ original: 'opus', fallback: 'sonnet', trigger: 'overloaded' })).toMatch(
      /Opus is overloaded right now — continuing on Sonnet/
    )
    expect(modelFallbackFrom({ type: 'system', subtype: 'init' })).toBeNull()
  })
})
