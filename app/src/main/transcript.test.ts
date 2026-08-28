import { describe, it, expect } from 'vitest'
import { TranscriptProjector, projectLegacyItems, toLegacyItems, toolDiff } from './transcript'

const init = { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-fable-5' }
const delta = (text: string): Record<string, unknown> => ({
  type: 'stream_event',
  event: { type: 'content_block_delta', delta: { type: 'text_delta', text } }
})
const assistant = (content: Record<string, unknown>[], extra = {}): Record<string, unknown> => ({
  type: 'assistant',
  message: { id: 'msg-1', content, ...extra }
})

describe('TranscriptProjector', () => {
  it('turns init into a session event', () => {
    const p = new TranscriptProjector()
    expect(p.project(init).persist).toEqual([
      { kind: 'session', claudeSessionId: 'sess-1', model: 'claude-fable-5' }
    ])
  })

  it('streams deltas ephemerally and persists the final text once', () => {
    const p = new TranscriptProjector()
    expect(p.project(delta('Hel'))).toEqual({ persist: [], delta: 'Hel' })
    expect(p.project(delta('lo'))).toEqual({ persist: [], delta: 'lo' })
    const first = p.project(assistant([{ type: 'text', text: 'Hello' }]))
    expect(first.persist).toEqual([{ kind: 'assistant', id: 'msg-1-0', text: 'Hello' }])
    // The CLI may re-send the grown message; the block must not duplicate.
    const again = p.project(assistant([{ type: 'text', text: 'Hello' }]))
    expect(again.persist).toEqual([])
  })

  it('maps tool_use blocks to tool or diff events, once per tool id', () => {
    const p = new TranscriptProjector()
    const out = p.project(
      assistant([
        { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls   -la' } },
        {
          type: 'tool_use',
          id: 't2',
          name: 'Edit',
          input: { file_path: '/a/b/app.ts', old_string: 'x\ny\n', new_string: 'x\nz\n' }
        }
      ])
    ).persist
    expect(out).toEqual([
      { kind: 'tool', id: 't1', name: 'Bash', detail: 'ls -la' },
      { kind: 'diff', id: 't2', file: 'app.ts', hunks: [{ removed: ['y'], added: ['z'] }] }
    ])
    expect(
      p.project(assistant([{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }])).persist
    ).toEqual([])
  })

  it('reports tool results with a bounded summary', () => {
    const p = new TranscriptProjector()
    const out = p.project({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(1000), is_error: true }
        ]
      }
    }).persist
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'tool_result', toolId: 't1', ok: false })
    expect((out[0] as { summary: string }).summary).toHaveLength(400)
  })

  it('surfaces API errors as notices and ends the turn', () => {
    const p = new TranscriptProjector()
    const notice = p.project(
      assistant([{ type: 'text', text: 'You have hit your limit' }], { isApiErrorMessage: true })
    ).persist
    expect(notice).toEqual([{ kind: 'notice', text: 'You have hit your limit' }])
    const end = p.project({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      total_cost_usd: 0.12,
      usage: { input_tokens: 10, output_tokens: 5 }
    }).persist
    expect(end).toEqual([
      { kind: 'turn_end', ok: false, subtype: 'error_during_execution', costUsd: 0.12, tokens: 15 }
    ])
  })
})

describe('legacy transcripts', () => {
  const items = [
    {
      kind: 'msg',
      msg: { id: 'u1', role: 'user', text: 'hi', images: ['data:image/png;base64,AAA'] }
    },
    { kind: 'msg', msg: { id: 'a1', role: 'assistant', text: 'hello' } },
    { kind: 'msg', msg: { id: 's1', role: 'assistant', text: 'resumed fresh', system: true } },
    { kind: 'tool', tool: { id: 't1', name: 'Read', detail: 'x.ts' } },
    { kind: 'diff', diff: { id: 't2', file: 'y.ts', hunks: [{ removed: [], added: ['a'] }] } },
    { kind: 'thinking', id: 'th1', text: 'hmm' }
  ] as Parameters<typeof projectLegacyItems>[0]

  it('projects every renderer item kind', () => {
    const out = projectLegacyItems(items)
    expect(out.map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'notice',
      'tool',
      'diff',
      'thinking'
    ])
    expect(out[0]).toMatchObject({ images: [{ mediaType: 'image/png' }] })
  })

  it('round-trips wire events back into items the desktop can render', () => {
    const back = toLegacyItems(projectLegacyItems(items))
    expect(back.map((i) => i.kind)).toEqual(['msg', 'msg', 'msg', 'tool', 'diff', 'thinking'])
    expect(back[2]).toMatchObject({ msg: { system: true, text: 'resumed fresh' } })
  })
})

describe('toolDiff', () => {
  it('handles Write and MultiEdit and ignores other tools', () => {
    expect(toolDiff('Write', 'w', { file_path: 'n.md', content: 'a\nb\n' })).toEqual({
      kind: 'diff',
      id: 'w',
      file: 'n.md',
      hunks: [{ removed: [], added: ['a', 'b'] }]
    })
    expect(
      toolDiff('MultiEdit', 'm', {
        file_path: 'z.ts',
        edits: [{ old_string: '1', new_string: '2' }]
      })
    ).toMatchObject({ hunks: [{ removed: ['1'], added: ['2'] }] })
    expect(toolDiff('Bash', 'b', { command: 'ls' })).toBeNull()
  })
})
