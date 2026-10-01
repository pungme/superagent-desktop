import { describe, it, expect } from 'vitest'
import { modelBelongsTo, modeBelongsTo } from './agent-provider'

/**
 * A phone sends the model and mode from its own pickers, which are Claude
 * Code's, and until now it had no idea a conversation ran on Codex. Handing
 * Codex `--model opus` is not a bad setting — it is a CLI that refuses to
 * start, and the phone then sits there with no reply and nothing to explain it.
 */
describe('a setting belongs to one agent', () => {
  it('keeps Claude Code models for Claude Code', () => {
    for (const m of ['opus', 'sonnet', 'haiku', 'fable', 'mythos', 'default', 'opus[1m]', 'Sonnet']) {
      expect(modelBelongsTo(m, 'claude')).toBe(true)
      expect(modelBelongsTo(m, 'codex')).toBe(false)
    }
  })

  it('keeps Codex models for Codex', () => {
    for (const m of ['gpt-5-codex', 'o4-mini', 'gpt-5']) {
      expect(modelBelongsTo(m, 'codex')).toBe(true)
      expect(modelBelongsTo(m, 'claude')).toBe(false)
    }
  })

  it('keeps Antigravity models for Antigravity', () => {
    for (const m of ['gemini-3.8-flash-high', 'gemini-3.1-pro-low', 'gpt-oss-120b-medium']) {
      expect(modelBelongsTo(m, 'antigravity')).toBe(true)
      expect(modelBelongsTo(m, 'claude')).toBe(false)
      expect(modelBelongsTo(m, 'codex')).toBe(false)
    }
    // Antigravity resells Anthropic models under versioned ids; Claude Code's
    // own aliases and Codex's models still mean nothing to it.
    expect(modelBelongsTo('claude-sonnet-4-6', 'antigravity')).toBe(true)
    for (const m of ['opus', 'default', 'gpt-5-codex']) {
      expect(modelBelongsTo(m, 'antigravity')).toBe(false)
    }
  })

  it('lets an unset model through to either', () => {
    expect(modelBelongsTo(undefined, 'antigravity')).toBe(true)
    expect(modelBelongsTo(undefined, 'codex')).toBe(true)
    expect(modelBelongsTo(undefined, 'claude')).toBe(true)
  })

  it('keeps product permission modes for every backend', () => {
    for (const m of ['bypassPermissions', 'acceptEdits', 'plan', 'ask']) {
      expect(modeBelongsTo(m, 'claude')).toBe(true)
      expect(modeBelongsTo(m, 'codex')).toBe(true)
      expect(modeBelongsTo(m, 'antigravity')).toBe(true)
    }
    expect(modeBelongsTo(undefined, 'codex')).toBe(true)
  })
})
