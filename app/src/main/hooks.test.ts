import { describe, it, expect } from 'vitest'
import { mergeCoveHooks, removeCoveHooks } from './hooks'

const SCRIPT = '/Users/x/Library/Application Support/Cove/cove-hook.sh'

describe('mergeCoveHooks', () => {
  it('adds all five events to an empty settings object', () => {
    const out = mergeCoveHooks({}, SCRIPT)
    expect(Object.keys(out.hooks!)).toEqual([
      'SessionStart',
      'UserPromptSubmit',
      'Notification',
      'Stop',
      'SubagentStop'
    ])
  })

  it("preserves the user's existing hooks on the same event", () => {
    const existing = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }
    }
    const out = mergeCoveHooks(existing, SCRIPT)
    const stop = JSON.stringify(out.hooks!.Stop)
    expect(stop).toContain('echo mine')
    expect(stop).toContain('cove-hook.sh')
    expect((out.hooks!.Stop as unknown[]).length).toBe(2)
  })

  it('is idempotent — running twice does not duplicate Cove entries', () => {
    const once = mergeCoveHooks({}, SCRIPT)
    const twice = mergeCoveHooks(once, SCRIPT)
    expect((twice.hooks!.Stop as unknown[]).length).toBe(1)
  })

  it('preserves unrelated top-level settings keys', () => {
    const out = mergeCoveHooks({ model: 'opus', theme: 'dark' }, SCRIPT)
    expect(out.model).toBe('opus')
    expect(out.theme).toBe('dark')
  })
})

describe('removeCoveHooks', () => {
  it('round-trips: merge then remove leaves the original user hooks', () => {
    const original = {
      model: 'opus',
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] }
    }
    const merged = mergeCoveHooks(original, SCRIPT)
    const restored = removeCoveHooks(merged)
    expect(restored.hooks!.Stop).toEqual(original.hooks.Stop)
    expect(restored.model).toBe('opus')
  })

  it('drops event arrays that become empty', () => {
    const merged = mergeCoveHooks({}, SCRIPT)
    const restored = removeCoveHooks(merged)
    expect(restored.hooks).toEqual({})
  })
})
