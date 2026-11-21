import { describe, it, expect } from 'vitest'
import { groupModelOptions, modelPillLabel } from './model-groups'

const o = (
  value: string,
  label: string,
  hint: string
): { value: string; label: string; hint: string } => ({
  value,
  label,
  hint
})

// The shape `agy models` gives, after parseAgyModels.
const agy = [
  o('', 'Default', 'Whatever your account uses'),
  o('gemini-4-neon-high', 'Gemini 4 Neon', 'High'),
  o('gemini-4-neon-xhigh', 'Gemini 4 Neon', 'XHigh'),
  o('gemini-4-neon-medium', 'Gemini 4 Neon', 'Medium'),
  o('gemini-4-neon-low', 'Gemini 4 Neon', 'Low'),
  o('gemini-pro-orchestrator-neon', 'Orchestrator', 'Neon'),
  o('gemini-pro-orchestrator-g1-pro', 'Orchestrator', 'Argon'),
  o('gpt-oss-120b-medium', 'GPT-OSS 120B', 'Medium')
]

describe('groupModelOptions', () => {
  it('folds one model listed per effort into one row, efforts in order', () => {
    const rows = groupModelOptions(agy)
    expect(rows.map((r) => (r.kind === 'one' ? r.option.value : r.label))).toEqual([
      '',
      'Gemini 4 Neon',
      'gemini-pro-orchestrator-neon',
      'gemini-pro-orchestrator-g1-pro',
      'gpt-oss-120b-medium'
    ])
    const neon = rows[1]
    expect(neon.kind === 'efforts' && neon.efforts.map((e) => e.option.value)).toEqual([
      'gemini-4-neon-low',
      'gemini-4-neon-medium',
      'gemini-4-neon-high',
      'gemini-4-neon-xhigh'
    ])
  })

  it('leaves a line-up without efforts alone', () => {
    const claude = [
      o('', 'Default', 'Recommended'),
      o('opus', 'Opus', 'Most capable'),
      o('sonnet', 'Sonnet', 'Fast')
    ]
    expect(groupModelOptions(claude).every((r) => r.kind === 'one')).toBe(true)
  })
})

describe('modelPillLabel', () => {
  it('names the effort only when the model has several', () => {
    expect(modelPillLabel(agy, 'gemini-4-neon-xhigh')).toBe('Gemini 4 Neon · XHigh')
    expect(modelPillLabel(agy, 'gpt-oss-120b-medium')).toBe('GPT-OSS 120B')
    expect(modelPillLabel(agy, 'gemini-pro-orchestrator-neon')).toBe('Orchestrator')
    expect(modelPillLabel(agy, 'nope')).toBeUndefined()
  })
})
