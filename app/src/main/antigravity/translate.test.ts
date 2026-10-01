import { describe, it, expect } from 'vitest'
import {
  AntigravityTranslator,
  changedRegion,
  encodeUserTurn,
  mapTool,
  parseAgyLine,
  type StreamJsonEvent
} from './translate'

/**
 * The lines below are in the shapes Antigravity documents for
 * `--output-format stream-json` and that agy 1.2.x was captured emitting: an
 * `init`, `step_update`s that go ACTIVE then DONE, and one `result` per turn.
 */
const CONV = 'c3b66b04-872b-4fbe-a3a4-058a026ef20a'

const step = (fields: Record<string, unknown>): Record<string, unknown> => ({
  event: 'step_update',
  step_update: { conversation_id: CONV, ...fields }
})

const result = (fields: Record<string, unknown>): Record<string, unknown> => ({
  event: 'result',
  result: { conversation_id: CONV, duration_seconds: 1, num_turns: 1, ...fields }
})

function run(t: AntigravityTranslator, lines: Record<string, unknown>[]): StreamJsonEvent[] {
  return lines.flatMap((l) => t.handle(l))
}

/** The content blocks of every `assistant` event, flattened. */
function blocks(events: StreamJsonEvent[]): Record<string, unknown>[] {
  return events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => (e.message as { content: Record<string, unknown>[] }).content)
}

function toolResults(events: StreamJsonEvent[]): Record<string, unknown>[] {
  return events
    .filter((e) => e.type === 'user')
    .flatMap((e) => (e.message as { content: Record<string, unknown>[] }).content)
}

describe('init', () => {
  it('becomes the system/init the app waits for, carrying the conversation id', () => {
    const t = new AntigravityTranslator()
    const [init] = t.handle({
      event: 'init',
      conversation_id: CONV,
      init: { cwd: '/work', tools: ['run_command'], permission_mode: 'always-proceed' }
    })
    expect(init).toMatchObject({ type: 'system', subtype: 'init', session_id: CONV, cwd: '/work' })
    expect(t.conversationId).toBe(CONV)
  })

  it('names the model only when Antigravity does', () => {
    const t = new AntigravityTranslator()
    expect(t.handle({ event: 'init', conversation_id: CONV, init: {} })[0].model).toBeUndefined()
    expect(
      t.handle({ event: 'init', conversation_id: CONV, init: { model: 'gemini-3.8-flash-low' } })[0]
        .model
    ).toBe('gemini-3.8-flash-low')
  })
})

describe('a streamed answer', () => {
  const lines = [
    step({ step_index: 0, state: 'DONE', step_type: 'user_input' }),
    step({ step_index: 2, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'app' }),
    step({
      step_index: 2,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: 'le\n',
      usage: { input_tokens: 278, output_tokens: 4, cache_read_tokens: 30214, total_tokens: 282 }
    }),
    result({ status: 'SUCCESS', response: 'apple\n' })
  ]

  it('opens one text block, streams the deltas, and closes it with the whole text', () => {
    const events = run(new AntigravityTranslator(), lines)
    const stream = events.filter((e) => e.type === 'stream_event').map((e) => e.event)
    expect(stream.map((e) => (e as { type: string }).type)).toEqual([
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop'
    ])
    expect(blocks(events)).toEqual([{ type: 'text', text: 'apple\n' }])
  })

  it('does not show our own prompt coming back', () => {
    const events = new AntigravityTranslator().handle(lines[0])
    expect(events).toEqual([])
  })

  it('reports the prompt the model carried, cached tokens included, for the meter', () => {
    const events = run(new AntigravityTranslator(), lines)
    const assistant = events.find((e) => e.type === 'assistant')
    expect((assistant?.message as { usage: unknown }).usage).toEqual({
      input_tokens: 278,
      cache_read_input_tokens: 30214,
      cache_creation_input_tokens: 0,
      output_tokens: 4
    })
  })

  it('ends the turn with a success result', () => {
    const events = run(new AntigravityTranslator(), lines)
    const last = events[events.length - 1]
    expect(last).toMatchObject({ type: 'result', subtype: 'success', is_error: false })
  })

  it('puts an answer that arrived whole on screen', () => {
    const events = run(new AntigravityTranslator(), [
      result({ status: 'SUCCESS', response: 'Git, Subversion, Mercurial.' })
    ])
    expect(blocks(events)).toEqual([{ type: 'text', text: 'Git, Subversion, Mercurial.' }])
  })

  it('stamps the turn with everything it processed, not just the last step', () => {
    const usage = { input_tokens: 100, output_tokens: 10, cache_read_tokens: 5 }
    const events = run(new AntigravityTranslator(), [
      step({ step_index: 1, state: 'DONE', step_type: 'agent_response', usage }),
      step({ step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: 'ok', usage }),
      result({ status: 'SUCCESS', response: 'ok' })
    ])
    expect(events[events.length - 1].usage).toMatchObject({
      input_tokens: 200,
      output_tokens: 20,
      cache_read_input_tokens: 10
    })
  })
})

describe('tool calls', () => {
  it('turns run_command into a Bash card and its output into the result', () => {
    const events = run(new AntigravityTranslator(), [
      { event: 'init', conversation_id: CONV, init: {} },
      step({
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'ls -la' } }
      }),
      step({
        step_index: 2,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'ls -la' },
          output: 'total 0\n'
        }
      })
    ])
    const [use] = blocks(events)
    expect(use).toMatchObject({ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } })
    const [res] = toolResults(events)
    expect(res).toMatchObject({ tool_use_id: use.id, content: 'total 0\n', is_error: false })
  })

  it('still shows a step that was only reported once it was over', () => {
    const events = run(new AntigravityTranslator(), [
      step({
        step_index: 4,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'echo hi' }, output: 'hi\n' }
      })
    ])
    expect(blocks(events)).toHaveLength(1)
    expect(toolResults(events)).toHaveLength(1)
  })

  it('answers a card once, however many times DONE is reported', () => {
    const done = step({
      step_index: 4,
      state: 'DONE',
      step_type: 'tool',
      tool_name: 'view_file',
      tool_info: { name: 'view_file', parameters: { AbsolutePath: '/a.txt' }, output: '2 lines' }
    })
    const events = run(new AntigravityTranslator(), [done, done])
    expect(toolResults(events)).toHaveLength(1)
  })

  it('marks a failed tool as an error and says why', () => {
    const events = run(new AntigravityTranslator(), [
      step({
        step_index: 3,
        state: 'DONE',
        step_type: 'tool',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: '/nope' },
          error: { type: 'NOT_FOUND', message: 'file does not exist' }
        }
      })
    ])
    expect(toolResults(events)[0]).toMatchObject({
      content: 'file does not exist',
      is_error: true
    })
  })

  it('closes the card of a tool a hook refused, with the reason', () => {
    // What agy 1.2.14 emits when the PreToolUse hook says deny: state ERROR.
    const events = run(new AntigravityTranslator(), [
      step({
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'touch denied.txt' } }
      }),
      step({
        step_index: 4,
        state: 'ERROR',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: {
          name: 'run_command',
          parameters: { CommandLine: 'touch denied.txt' },
          error: {
            type: 'TOOL_ERROR',
            message:
              'tool call denied by pre-tool hook: The user declined this action in Superagent.'
          }
        }
      })
    ])
    expect(blocks(events)).toHaveLength(1)
    expect(toolResults(events)[0]).toMatchObject({
      is_error: true,
      content: 'tool call denied by pre-tool hook: The user declined this action in Superagent.'
    })
  })

  it('closes the text it was streaming before a tool card appears', () => {
    const events = run(new AntigravityTranslator(), [
      step({ step_index: 1, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'Looking' }),
      step({
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'list_dir',
        tool_info: { name: 'list_dir', parameters: { DirectoryPath: '/work' } }
      })
    ])
    const kinds = blocks(events).map((b) => b.type)
    expect(kinds).toEqual(['text', 'tool_use'])
  })

  it('keeps card ids apart when a conversation is replaced by a fresh one', () => {
    const tool = step({
      step_index: 2,
      state: 'ACTIVE',
      step_type: 'tool',
      tool_name: 'list_dir',
      tool_info: { name: 'list_dir', parameters: { DirectoryPath: '/' } }
    })
    const a = new AntigravityTranslator()
    a.handle({ event: 'init', conversation_id: 'aaaaaaaa-1111', init: {} })
    const b = new AntigravityTranslator()
    b.handle({ event: 'init', conversation_id: 'bbbbbbbb-2222', init: {} })
    const first = blocks(
      a.handle({
        ...tool,
        step_update: { ...(tool.step_update as object), conversation_id: 'aaaaaaaa-1111' }
      })
    )[0].id
    const second = blocks(
      b.handle({
        ...tool,
        step_update: { ...(tool.step_update as object), conversation_id: 'bbbbbbbb-2222' }
      })
    )[0].id
    expect(first).not.toBe(second)
  })
})

describe('Superagent’s own tools', () => {
  it('unwraps call_mcp_tool into the mcp__server__tool name the cards key on', () => {
    expect(
      mapTool('call_mcp_tool', {
        ServerName: 'cove-browser',
        ToolName: 'browser_navigate',
        Arguments: { url: 'https://example.com' }
      })
    ).toEqual({
      name: 'mcp__cove-browser__browser_navigate',
      input: { url: 'https://example.com' }
    })
  })

  it('reads arguments that arrive as a JSON string', () => {
    expect(
      mapTool('call_mcp_tool', {
        ServerName: 'cove-browser',
        ToolName: 'board_add',
        Arguments: '{"title":"Ship it"}'
      }).input
    ).toEqual({ title: 'Ship it' })
  })
})

describe('mapTool', () => {
  it('maps the file and search tools onto the names the renderer knows', () => {
    expect(mapTool('view_file', { AbsolutePath: '/a.ts', StartLine: 10, EndLine: 19 })).toEqual({
      name: 'Read',
      input: { file_path: '/a.ts', offset: 10, limit: 10 }
    })
    expect(mapTool('write_to_file', { TargetFile: '/a.ts', CodeContent: 'x' })).toEqual({
      name: 'Write',
      input: { file_path: '/a.ts', content: 'x' }
    })
    expect(
      mapTool('replace_file_content', {
        TargetFile: '/a.ts',
        TargetContent: 'old',
        ReplacementContent: 'new'
      })
    ).toEqual({ name: 'Edit', input: { file_path: '/a.ts', old_string: 'old', new_string: 'new' } })
    expect(mapTool('grep_search', { SearchPath: '/src', Query: 'TODO' })).toEqual({
      name: 'Grep',
      input: { pattern: 'TODO', path: '/src' }
    })
    expect(mapTool('find_by_name', { SearchDirectory: '/src', Pattern: '*.ts' })).toEqual({
      name: 'Glob',
      input: { pattern: '*.ts', path: '/src' }
    })
    expect(mapTool('search_web', { query: 'vitest' }).name).toBe('WebSearch')
    expect(mapTool('read_url_content', { Url: 'https://x.dev' })).toEqual({
      name: 'WebFetch',
      input: { url: 'https://x.dev' }
    })
  })

  it('renders a multi-chunk edit as one edit per chunk', () => {
    const mapped = mapTool('multi_replace_file_content', {
      TargetFile: '/a.ts',
      ReplacementChunks: [
        { TargetContent: 'a', ReplacementContent: 'b', StartLine: 1, EndLine: 1 },
        { TargetContent: 'c', ReplacementContent: 'd', StartLine: 9, EndLine: 9 }
      ]
    })
    expect(mapped.name).toBe('MultiEdit')
    expect(mapped.input.edits).toEqual([
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' }
    ])
  })

  it('passes a tool it does not know through under its own name', () => {
    expect(mapTool('generate_image', { Prompt: 'a cat' })).toEqual({
      name: 'generate_image',
      input: { Prompt: 'a cat' }
    })
  })

  it('describes a subagent call by the roles it spawned', () => {
    const mapped = mapTool('invoke_subagent', {
      Subagents: [
        { Role: 'Researcher A', Prompt: 'read a.txt', TypeName: 'research' },
        { Role: 'Researcher B', Prompt: 'read b.txt', TypeName: 'research' }
      ]
    })
    expect(mapped).toMatchObject({
      name: 'Task',
      input: { description: 'Researcher A, Researcher B', subagent_type: 'research' }
    })
  })
})

describe('file edits', () => {
  // The stream names the file an edit touched and nothing else, so the diff
  // comes from the file before and after.
  const edit = (state: string): Record<string, unknown> =>
    step({
      step_index: 4,
      state,
      step_type: 'tool',
      tool_name: 'replace_file_content',
      tool_info: { name: 'replace_file_content', parameters: { TargetFile: '/work/hello.txt' } }
    })

  it('holds the card until the edit is done, then shows what changed', () => {
    let content = 'one\ntwo\nthree\n'
    const t = new AntigravityTranslator({ readFile: () => content })
    expect(t.handle(edit('ACTIVE'))).toEqual([])
    content = 'one\nTWO\nthree\n'
    const events = t.handle(edit('DONE'))
    expect(blocks(events)[0]).toMatchObject({
      type: 'tool_use',
      name: 'Edit',
      input: {
        file_path: '/work/hello.txt',
        old_string: 'one\ntwo\nthree',
        new_string: 'one\nTWO\nthree'
      }
    })
    expect(toolResults(events)).toHaveLength(1)
  })

  it('shows a file that did not exist before as a Write of all of it', () => {
    let content: string | null = null
    const t = new AntigravityTranslator({ readFile: () => content })
    const write = (state: string): Record<string, unknown> =>
      step({
        step_index: 2,
        state,
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: { name: 'write_to_file', parameters: { TargetFile: '/work/new.txt' } }
      })
    t.handle(write('ACTIVE'))
    content = 'hello\n'
    expect(blocks(t.handle(write('DONE')))[0]).toMatchObject({
      name: 'Write',
      input: { file_path: '/work/new.txt', content: 'hello\n' }
    })
  })

  it('still gives the edit a card when the file cannot be read', () => {
    const t = new AntigravityTranslator()
    t.handle(edit('ACTIVE'))
    expect(blocks(t.handle(edit('DONE')))[0]).toMatchObject({
      name: 'Edit',
      input: { file_path: '/work/hello.txt' }
    })
  })

  it('keeps only the region that moved, with a little around it', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')
    const after = before.replace('line 10', 'LINE TEN')
    const region = changedRegion(before, after)
    expect(region?.old_string.split('\n')).toEqual([
      'line 7',
      'line 8',
      'line 9',
      'line 10',
      'line 11',
      'line 12',
      'line 13'
    ])
    expect(region?.new_string).toContain('LINE TEN')
    expect(changedRegion('same', 'same')).toBeNull()
  })
})

describe('subagents', () => {
  it('answers the invoke_subagent card once its children are dispatched', () => {
    const t = new AntigravityTranslator()
    const events = run(t, [
      step({
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'invoke_subagent',
        tool_info: {
          name: 'invoke_subagent',
          parameters: {
            Subagents: [{ Role: 'Researcher A', Prompt: 'read a.txt', TypeName: 'research' }]
          }
        }
      }),
      step({
        step_index: 2,
        state: 'DONE',
        step_type: 'subagent',
        tool_name: 'invoke_subagent',
        subagent_info: { subagents: [{ type_name: 'research', role: 'Researcher A' }] }
      })
    ])
    expect(blocks(events)).toHaveLength(1)
    expect(blocks(events)[0]).toMatchObject({ name: 'Task' })
    expect(toolResults(events)[0]).toMatchObject({
      tool_use_id: blocks(events)[0].id,
      content: 'Started a subagent: Researcher A.',
      is_error: false
    })
  })
})

describe('a turn that does not end well', () => {
  it('reports an error result with what Antigravity said', () => {
    const events = run(new AntigravityTranslator(), [
      result({ status: 'ERROR', response: '', error: 'UNAVAILABLE (code 503)' })
    ])
    expect(events[events.length - 1]).toEqual({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: 'UNAVAILABLE (code 503)'
    })
  })

  it('does not call an interrupted turn an error', () => {
    const events = run(new AntigravityTranslator(), [
      step({
        step_index: 1,
        state: 'ACTIVE',
        step_type: 'agent_response',
        text_delta: 'Half a sen'
      }),
      result({ status: 'ERROR', response: '', error: 'interrupted' })
    ])
    // The sentence it was in the middle of is closed, not left spinning.
    expect(blocks(events)).toEqual([{ type: 'text', text: 'Half a sen' }])
    expect(events[events.length - 1]).toMatchObject({ type: 'result', is_error: false })
  })

  it('closes a card that was still open, so nothing is left spinning', () => {
    const t = new AntigravityTranslator()
    const events = run(t, [
      step({
        step_index: 2,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'run_command',
        tool_info: { name: 'run_command', parameters: { CommandLine: 'sleep 600' } }
      }),
      ...[]
    ]).concat(t.abortTurn(true))
    expect(toolResults(events)).toHaveLength(1)
    expect(toolResults(events)[0].is_error).toBe(true)
    expect(events[events.length - 1]).toMatchObject({ type: 'result', is_error: false })
  })

  it('gives an edit that never finished its card anyway', () => {
    const t = new AntigravityTranslator({ readFile: () => 'x' })
    t.handle(
      step({
        step_index: 4,
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: { name: 'write_to_file', parameters: { TargetFile: '/work/a.txt' } }
      })
    )
    const events = t.abortTurn(false, 'agy crashed')
    expect(blocks(events)[0]).toMatchObject({ name: 'Write' })
    expect(events[events.length - 1]).toMatchObject({ is_error: true, result: 'agy crashed' })
  })
})

describe('the wire', () => {
  it('ignores anything on stdout that is not an event', () => {
    expect(parseAgyLine('')).toBeNull()
    expect(parseAgyLine('Fetching available models...')).toBeNull()
    expect(parseAgyLine('{"no":"event"}')).toBeNull()
    expect(parseAgyLine('{"event":"init","conversation_id":"x"}')).toMatchObject({ event: 'init' })
  })

  it('writes a turn as the one block type agy accepts', () => {
    expect(JSON.parse(encodeUserTurn('hi'))).toEqual({
      event: 'user',
      message: { content: [{ type: 'text', text: 'hi' }] }
    })
    expect(encodeUserTurn('hi').endsWith('\n')).toBe(true)
  })

  it('drops bookkeeping steps', () => {
    const t = new AntigravityTranslator()
    expect(t.handle(step({ step_index: 4, state: 'DONE', step_type: 'checkpoint' }))).toEqual([])
    expect(t.handle(step({ step_index: 5, state: 'DONE', step_type: 'system_message' }))).toEqual(
      []
    )
    expect(t.handle({ event: 'something_new' })).toEqual([])
  })
})
