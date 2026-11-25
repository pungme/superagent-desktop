import { describe, it, expect } from 'vitest'
import {
  AGENTS_KEPT,
  STEPS_KEPT,
  currentStep,
  noteSubagentEvent,
  stepDetail,
  type SubActivity
} from './subagent-activity'

const tool = (
  parent: string | null,
  id: string,
  name: string,
  input: unknown
): Record<string, unknown> => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_use', id, name, input }] }
})
const result = (parent: string, id: string, isError = false): Record<string, unknown> => ({
  type: 'user',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError }] }
})

describe('a sub-agent’s activity', () => {
  it('ignores what the main agent does', () => {
    const a: SubActivity = new Map()
    expect(noteSubagentEvent(a, tool(null, 't1', 'Bash', { command: 'ls' }), 1)).toBe(false)
    expect(noteSubagentEvent(a, { type: 'assistant', message: { content: [] } }, 1)).toBe(false)
    expect(a.size).toBe(0)
  })

  it('records its tool calls under the agent that made them', () => {
    const a: SubActivity = new Map()
    noteSubagentEvent(
      a,
      tool('agent-1', 't1', 'Bash', { command: 'cd /x &&   python  slow.py' }),
      10
    )
    noteSubagentEvent(a, tool('agent-2', 't2', 'Read', { file_path: '/y/z.ts' }), 11)
    expect(a.get('agent-1')).toEqual([
      { id: 't1', kind: 'tool', name: 'Bash', detail: 'cd /x && python slow.py', at: 10 }
    ])
    expect(a.get('agent-2')![0].detail).toBe('/y/z.ts')
  })

  it('marks a call done, and whether it worked', () => {
    const a: SubActivity = new Map()
    noteSubagentEvent(a, tool('g', 't1', 'Bash', { command: 'a' }), 1)
    noteSubagentEvent(a, tool('g', 't2', 'Bash', { command: 'b' }), 2)
    noteSubagentEvent(a, result('g', 't1'), 3)
    noteSubagentEvent(a, result('g', 't2', true), 4)
    expect(a.get('g')!.map((s) => [s.done, s.ok])).toEqual([
      [true, true],
      [true, false]
    ])
  })

  it('records what it said, cut short', () => {
    const a: SubActivity = new Map()
    noteSubagentEvent(
      a,
      {
        type: 'assistant',
        parent_tool_use_id: 'g',
        message: { content: [{ type: 'text', text: 'Found it.\n\n' + 'x'.repeat(500) }] }
      },
      5
    )
    const s = a.get('g')![0]
    expect(s.kind).toBe('text')
    expect(s.detail.startsWith('Found it. xxx')).toBe(true)
    expect(s.detail.length).toBe(300)
  })

  it('does not record the same call twice (a replayed event)', () => {
    const a: SubActivity = new Map()
    noteSubagentEvent(a, tool('g', 't1', 'Bash', { command: 'a' }), 1)
    expect(noteSubagentEvent(a, tool('g', 't1', 'Bash', { command: 'a' }), 2)).toBe(false)
    expect(a.get('g')).toHaveLength(1)
  })

  it('keeps the latest steps and the latest agents only', () => {
    const a: SubActivity = new Map()
    for (let i = 0; i < STEPS_KEPT + 10; i++)
      noteSubagentEvent(a, tool('g', `t${i}`, 'Bash', { command: `c${i}` }), i)
    expect(a.get('g')).toHaveLength(STEPS_KEPT)
    expect(a.get('g')![0].id).toBe('t10')
    for (let i = 0; i < AGENTS_KEPT + 5; i++)
      noteSubagentEvent(a, tool(`a${i}`, 'x', 'Bash', {}), i)
    expect(a.size).toBe(AGENTS_KEPT)
    expect(a.has('g')).toBe(false)
  })

  it('says what it is doing now: the call still waiting, else the last thing', () => {
    const a: SubActivity = new Map()
    noteSubagentEvent(a, tool('g', 't1', 'Read', { file_path: 'a.ts' }), 1)
    noteSubagentEvent(a, tool('g', 't2', 'Bash', { command: 'python slow.py' }), 2)
    noteSubagentEvent(a, result('g', 't1'), 3)
    expect(currentStep(a.get('g'))!.detail).toBe('python slow.py')
    noteSubagentEvent(a, result('g', 't2'), 4)
    expect(currentStep(a.get('g'))!.id).toBe('t2')
    expect(currentStep(undefined)).toBeNull()
  })

  it('reads a call’s detail from whatever it carries', () => {
    expect(stepDetail({ query: 'react table perf' })).toBe('react table perf')
    expect(stepDetail({ path: '/a/b' })).toBe('/a/b')
    expect(stepDetail(null)).toBe('')
    expect(stepDetail({ command: 'x'.repeat(400) })).toHaveLength(160)
  })
})
