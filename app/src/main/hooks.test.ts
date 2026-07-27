import { describe, it, expect } from 'vitest'
import { mergeCoveHooks, removeCoveHooks } from './hooks'

const SCRIPT = '/Users/x/Library/Application Support/SuperAgent/cove-hook.sh'

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

  it('is idempotent — running twice does not duplicate SuperAgent entries', () => {
    const once = mergeCoveHooks({}, SCRIPT)
    const twice = mergeCoveHooks(once, SCRIPT)
    expect((twice.hooks!.Stop as unknown[]).length).toBe(1)
  })

  it('preserves unrelated top-level settings keys', () => {
    const out = mergeCoveHooks({ model: 'opus', theme: 'dark' }, SCRIPT)
    expect(out.model).toBe('opus')
    expect(out.theme).toBe('dark')
  })

  it('quotes the script path so spaces (Application Support) do not break the shell', () => {
    const out = mergeCoveHooks({}, SCRIPT)
    const cmd = (out.hooks!.Stop as { hooks: { command: string }[] }[])[0].hooks[0].command
    // The path has a space; it must be quoted.
    expect(cmd).toContain(`'${SCRIPT}'`)
    expect(cmd).toBe(`sh '${SCRIPT}' Stop`)
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

  it('passes through an unexpected non-array hook value instead of dropping it', () => {
    const settings = {
      hooks: {
        Stop: [{ hooks: [{ type: 'command', command: `sh '${SCRIPT}' Stop` }] }],
        // A shape SuperAgent doesn't produce — must survive an uninstall untouched.
        Custom: { weird: true }
      }
    } as unknown as Parameters<typeof removeCoveHooks>[0]
    const restored = removeCoveHooks(settings)
    expect((restored.hooks as Record<string, unknown>).Custom).toEqual({ weird: true })
    // The SuperAgent-only Stop entry is still stripped (array becomes empty → dropped).
    expect(restored.hooks!.Stop).toBeUndefined()
  })
})
