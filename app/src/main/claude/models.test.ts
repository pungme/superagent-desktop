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

  it('marks earlier versions of a family the list already carries as older', () => {
    const list = toModelOptions([
      { value: 'default', displayName: 'Default (recommended)', description: 'Opus 5.5' },
      { value: 'opus', displayName: 'Opus 5.5', description: 'For complex work' },
      { value: 'claude-fable-5-1', displayName: 'Fable 5.1', description: 'Toughest' },
      { value: 'sonnet', displayName: 'Sonnet 5', description: 'Routine' },
      { value: 'claude-opus-5', displayName: 'Opus 5', description: 'Everyday' },
      { value: 'claude-fable-5', displayName: 'Fable 5', description: 'Hardest' },
      { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Everyday' },
      { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Routine' }
    ])
    expect(list.map((m) => [m.label, m.older ?? false])).toEqual([
      ['Default', false],
      ['Opus 5.5', false],
      ['Fable 5.1', false],
      ['Sonnet 5', false],
      ['Opus 5', true],
      ['Fable 5', true],
      ['Opus 4.8', true],
      ['Sonnet 4.6', true]
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
