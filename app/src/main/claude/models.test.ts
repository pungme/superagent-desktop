import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

import { toModelOptions } from './models'
import { modelBelongsTo } from '../../shared/agent-provider'

describe('toModelOptions', () => {
  it("maps the CLI's initialize models to picker options", () => {
    expect(
      toModelOptions([
        {
          value: 'default',
          displayName: 'Default (recommended)',
          description: 'Opus 5.5 with 1M context · Best for everyday, complex tasks'
        },
        { value: 'opus[1m]', displayName: 'Opus (1M context)', description: 'Opus 5.5' },
        { value: 'claude-fable-5-1[1m]', displayName: 'Fable', description: 'Fable 5.1' },
        { value: 'haiku', displayName: 'Haiku' },
        { displayName: 'no value' },
        null
      ])
    ).toEqual([
      {
        id: '',
        label: 'Default',
        hint: 'Opus 5.5 with 1M context · Best for everyday, complex tasks'
      },
      { id: 'opus[1m]', label: 'Opus', hint: 'Opus 5.5' },
      { id: 'claude-fable-5-1[1m]', label: 'Fable', hint: 'Fable 5.1' },
      { id: 'haiku', label: 'Haiku', hint: '' }
    ])
  })

  it('returns nothing for a malformed reply', () => {
    expect(toModelOptions(undefined)).toEqual([])
  })

  it('treats full Claude ids from the CLI as Claude models', () => {
    expect(modelBelongsTo('claude-fable-5-1[1m]', 'claude')).toBe(true)
    expect(modelBelongsTo('claude-fable-5-1[1m]', 'codex')).toBe(false)
  })
})
