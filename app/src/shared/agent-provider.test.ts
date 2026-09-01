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
    for (const m of ['opus', 'sonnet', 'haiku', 'default', 'opus[1m]', 'Sonnet']) {
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

  it('lets an unset model through to either', () => {
    expect(modelBelongsTo(undefined, 'codex')).toBe(true)
    expect(modelBelongsTo(undefined, 'claude')).toBe(true)
  })

  it('keeps Claude Code permission modes for Claude Code', () => {
    for (const m of ['bypassPermissions', 'acceptEdits', 'plan', 'ask']) {
      expect(modeBelongsTo(m, 'claude')).toBe(true)
      expect(modeBelongsTo(m, 'codex')).toBe(false)
    }
    expect(modeBelongsTo(undefined, 'codex')).toBe(true)
  })
})
