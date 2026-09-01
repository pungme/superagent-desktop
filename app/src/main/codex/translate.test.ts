import { describe, it, expect } from 'vitest'
import { CodexTranslator, unwrapShellCommand, hunksFromUnifiedDiff } from './translate'

/**
 * Codex's app-server notifications, turned into the stream-json vocabulary the
 * rest of the app already speaks. The fixtures here are shapes observed from a
 * real `codex app-server`, not invented ones.
 */

const flat = (
  t: CodexTranslator,
  calls: [string, Record<string, unknown>][]
): Record<string, unknown>[] => calls.flatMap(([method, params]) => t.handle(method, params))

describe('unwrapShellCommand', () => {
  it('peels the shell wrapper Codex runs commands through', () => {
    expect(unwrapShellCommand(`/bin/zsh -lc "ls /tmp"`)).toBe('ls /tmp')
    expect(unwrapShellCommand(`/bin/zsh -lc 'npm test'`)).toBe('npm test')
  })

  it('peels a nested wrapper', () => {
    expect(unwrapShellCommand(`/bin/zsh -lc "bash -lc 'echo hi'"`)).toBe('echo hi')
  })

  it('leaves a plain command alone', () => {
    expect(unwrapShellCommand('git status')).toBe('git status')
  })

  it('keeps a command that only looks like a wrapper', () => {
    // Trailing arguments after the quoted string mean this is not a plain wrapper.
    expect(unwrapShellCommand(`sh -c "foo" bar`)).toBe(`sh -c "foo" bar`)
  })
})

describe('hunksFromUnifiedDiff', () => {
  it('splits a multi-hunk diff into one hunk per change', () => {
    const diff = [
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,2 @@',
      '-const a = 1',
      '+const a = 2',
      '@@ -10,2 +10,2 @@',
      '-const b = 3',
      '+const b = 4'
    ].join('\n')
    expect(hunksFromUnifiedDiff(diff)).toEqual([
      { removed: ['const a = 1'], added: ['const a = 2'] },
      { removed: ['const b = 3'], added: ['const b = 4'] }
    ])
  })

  it('keeps context lines on both sides so the card shows surroundings', () => {
    const diff = ['@@ -1,3 +1,3 @@', ' keep', '-old', '+new'].join('\n')
    expect(hunksFromUnifiedDiff(diff)).toEqual([
      { removed: ['keep', 'old'], added: ['keep', 'new'] }
    ])
  })

  it('ignores file headers and no-newline markers', () => {
    const diff = [
      'diff --git a/x b/x',
      'index 1..2',
      '--- a/x',
      '+++ b/x',
      '+only',
      '\\ No newline'
    ].join('\n')
    expect(hunksFromUnifiedDiff(diff)).toEqual([{ removed: [], added: ['only'] }])
  })
})

describe('agent messages', () => {
  it('streams deltas as text blocks and closes with an assistant event', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const out = flat(t, [
      ['item/started', { item: { id: 'm1', type: 'agentMessage', text: '' } }],
      ['item/agentMessage/delta', { itemId: 'm1', delta: 'Hel' }],
      ['item/agentMessage/delta', { itemId: 'm1', delta: 'lo' }],
      ['item/completed', { item: { id: 'm1', type: 'agentMessage', text: 'Hello' } }]
    ])
    expect(out.map((e) => e.type)).toEqual([
      'stream_event',
      'stream_event',
      'stream_event',
      'stream_event',
      'assistant'
    ])
    const start = out[0].event as Record<string, unknown>
    expect(start.type).toBe('content_block_start')
    expect((start.content_block as Record<string, unknown>).type).toBe('text')
    const delta = (out[1].event as Record<string, unknown>).delta as Record<string, unknown>
    expect(delta).toEqual({ type: 'text_delta', text: 'Hel' })
    expect((out[3].event as Record<string, unknown>).type).toBe('content_block_stop')
    const msg = out[4].message as { content: { type: string; text: string }[] }
    expect(msg.content).toEqual([{ type: 'text', text: 'Hello' }])
  })

  it('sends reasoning as thinking, which the chat already renders separately', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const out = flat(t, [
      ['item/started', { item: { id: 'r1', type: 'reasoning' } }],
      ['item/reasoning/summaryTextDelta', { itemId: 'r1', delta: 'weighing options' }],
      ['item/completed', { item: { id: 'r1', type: 'reasoning' } }]
    ])
    const start = (out[0].event as Record<string, unknown>).content_block as Record<string, unknown>
    expect(start.type).toBe('thinking')
    expect((out[1].event as Record<string, unknown>).delta).toEqual({
      type: 'thinking_delta',
      thinking: 'weighing options'
    })
    expect((out[2].event as Record<string, unknown>).type).toBe('content_block_stop')
  })
})

describe('tool items', () => {
  it('renders a command as a Bash tool_use with the wrapper stripped', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const out = flat(t, [
      [
        'item/started',
        {
          item: {
            id: 'c1',
            type: 'commandExecution',
            command: `/bin/zsh -lc "npm test"`,
            cwd: '/repo',
            status: 'inProgress'
          }
        }
      ],
      [
        'item/completed',
        {
          item: {
            id: 'c1',
            type: 'commandExecution',
            command: `/bin/zsh -lc "npm test"`,
            aggregatedOutput: '2 passing\n',
            exitCode: 0,
            status: 'completed'
          }
        }
      ]
    ])
    const use = (out[0].message as { content: Record<string, unknown>[] }).content[0]
    expect(use).toMatchObject({
      type: 'tool_use',
      id: 'c1',
      name: 'Bash',
      input: { command: 'npm test', cwd: '/repo' }
    })
    const result = (out[1].message as { content: Record<string, unknown>[] }).content[0]
    expect(result).toMatchObject({ type: 'tool_result', tool_use_id: 'c1', is_error: false })
    expect(result.content).toContain('2 passing')
  })

  it('marks a failed command as an error and says the exit code', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const [event] = t.handle('item/completed', {
      item: {
        id: 'c2',
        type: 'commandExecution',
        aggregatedOutput: 'boom',
        exitCode: 127,
        status: 'failed'
      }
    })
    const result = (event.message as { content: Record<string, unknown>[] }).content[0]
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('exit 127')
  })

  it('renders a new file as a Write, so the diff card shows every line added', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const [event] = t.handle('item/started', {
      item: {
        id: 'f1',
        type: 'fileChange',
        changes: [
          { path: '/repo/new.ts', kind: { type: 'add' }, diff: '@@\n+const a = 1\n+export {}' }
        ]
      }
    })
    const use = (event.message as { content: Record<string, unknown>[] }).content[0]
    expect(use).toMatchObject({
      name: 'Write',
      input: { file_path: '/repo/new.ts', content: 'const a = 1\nexport {}' }
    })
  })

  it('renders an edit as a MultiEdit, one edit per hunk', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const [event] = t.handle('item/started', {
      item: {
        id: 'f2',
        type: 'fileChange',
        changes: [
          {
            path: '/repo/x.ts',
            kind: { type: 'update', move_path: null },
            diff: '@@ -1 +1 @@\n-a\n+b\n@@ -9 +9 @@\n-c\n+d'
          }
        ]
      }
    })
    const use = (event.message as { content: Record<string, unknown>[] }).content[0] as {
      name: string
      input: { edits: unknown[] }
    }
    expect(use.name).toBe('MultiEdit')
    expect(use.input.edits).toEqual([
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' }
    ])
  })

  it('gives each file in a multi-file change its own card', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const events = t.handle('item/started', {
      item: {
        id: 'f3',
        type: 'fileChange',
        changes: [
          { path: '/a', kind: { type: 'add' }, diff: '+x' },
          { path: '/b', kind: { type: 'add' }, diff: '+y' }
        ]
      }
    })
    expect(events).toHaveLength(2)
    const ids = events.map(
      (e) => ((e.message as { content: Record<string, unknown>[] }).content[0] as { id: string }).id
    )
    expect(ids).toEqual(['f3-0', 'f3-1'])
  })

  it('names an MCP call the way the chat already labels Superagent tools', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const [event] = t.handle('item/started', {
      item: {
        id: 't1',
        type: 'mcpToolCall',
        server: 'cove-browser',
        tool: 'browser_navigate',
        arguments: { url: 'https://example.com' }
      }
    })
    const use = (event.message as { content: Record<string, unknown>[] }).content[0]
    // The renderer strips this prefix to show "navigate" with a globe icon, and
    // `*open_file` handover cards key on the same shape.
    expect(use.name).toBe('mcp__cove-browser__browser_navigate')
    expect(use.input).toEqual({ url: 'https://example.com' })
  })

  it('reports an MCP failure as an errored tool_result', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const [event] = t.handle('item/completed', {
      item: { id: 't2', type: 'mcpToolCall', error: { message: 'user rejected MCP tool call' } }
    })
    const result = (event.message as { content: Record<string, unknown>[] }).content[0]
    expect(result.is_error).toBe(true)
    expect(result.content).toBe('user rejected MCP tool call')
  })
})

describe('plan → the Tasks panel', () => {
  it('creates each step once and answers with the id the panel re-keys on', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const out = t.handle('turn/plan/updated', {
      plan: [
        { step: 'Read the config', status: 'pending' },
        { step: 'Fix the bug', status: 'pending' }
      ]
    })
    const uses = out.filter((e) => e.type === 'assistant')
    expect(uses).toHaveLength(2)
    const first = (uses[0].message as { content: Record<string, unknown>[] }).content[0]
    expect(first).toMatchObject({ name: 'TaskCreate', input: { subject: 'Read the config' } })
    // TaskCreate's result carries the assigned id; without it the panel would
    // keep its provisional key and every later update would be dropped.
    const results = out.filter((e) => e.type === 'user')
    expect((results[0].message as { content: { content: string }[] }).content[0].content).toBe(
      'Task #1 created'
    )
  })

  it('sends only what changed on the next plan, not the whole list again', () => {
    const t = new CodexTranslator()
    t.startTurn()
    t.handle('turn/plan/updated', {
      plan: [
        { step: 'Read the config', status: 'pending' },
        { step: 'Fix the bug', status: 'pending' }
      ]
    })
    const out = t.handle('turn/plan/updated', {
      plan: [
        { step: 'Read the config', status: 'completed' },
        { step: 'Fix the bug', status: 'pending' }
      ]
    })
    const uses = out.filter((e) => e.type === 'assistant')
    expect(uses).toHaveLength(1)
    expect((uses[0].message as { content: Record<string, unknown>[] }).content[0]).toMatchObject({
      name: 'TaskUpdate',
      input: { taskId: '1', status: 'completed' }
    })
  })

  it("translates Codex's inProgress into the status the panel stores", () => {
    const t = new CodexTranslator()
    t.startTurn()
    const out = t.handle('turn/plan/updated', { plan: [{ step: 'Go', status: 'inProgress' }] })
    const update = out
      .filter((e) => e.type === 'assistant')
      .map((e) => (e.message as { content: Record<string, unknown>[] }).content[0])
      .find((c) => (c as { name: string }).name === 'TaskUpdate')
    expect(update).toMatchObject({ input: { status: 'in_progress' } })
  })
})

describe('turn end', () => {
  it('reports usage the context meter can read', () => {
    const t = new CodexTranslator()
    t.startTurn()
    t.handle('thread/tokenUsage/updated', {
      tokenUsage: {
        last: {
          inputTokens: 1000,
          cachedInputTokens: 400,
          cacheWriteInputTokens: 10,
          outputTokens: 50
        },
        modelContextWindow: 272_000
      }
    })
    const [result] = t.handle('turn/completed', { turn: { id: 'x', status: 'completed' } })
    expect(result).toMatchObject({ type: 'result', subtype: 'success', is_error: false })
    // input_tokens excludes the cached part, which is reported separately — the
    // meter sums the three, so double-counting would overstate the context.
    expect(result.usage).toEqual({
      input_tokens: 600,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 10,
      output_tokens: 50
    })
    expect(t.modelContextWindow).toBe(272_000)
  })

  it('closes a block still open when the turn was interrupted', () => {
    const t = new CodexTranslator()
    t.startTurn()
    t.handle('item/started', { item: { id: 'm1', type: 'agentMessage' } })
    t.handle('item/agentMessage/delta', { itemId: 'm1', delta: 'half a sen' })
    const out = t.handle('turn/completed', { turn: { id: 'x', status: 'interrupted' } })
    // Without the stop the chat leaves a message spinning forever.
    expect((out[0].event as Record<string, unknown>).type).toBe('content_block_stop')
    const msg = out[1].message as { content: { text: string }[] }
    expect(msg.content[0].text).toBe('half a sen')
    expect(out[2]).toMatchObject({ type: 'result', is_error: false })
  })

  it('surfaces a failed turn as an errored result', () => {
    const t = new CodexTranslator()
    t.startTurn()
    const [result] = t.handle('turn/completed', {
      turn: { id: 'x', status: 'failed', error: { message: 'rate limit reached' } }
    })
    expect(result).toMatchObject({ is_error: true, result: 'rate limit reached' })
  })

  it('stays quiet about an error Codex is already retrying', () => {
    const t = new CodexTranslator()
    expect(t.handle('error', { willRetry: true, error: { message: 'transient' } })).toEqual([])
    expect(t.handle('error', { willRetry: false, error: { message: 'fatal' } })).toHaveLength(1)
  })
})
