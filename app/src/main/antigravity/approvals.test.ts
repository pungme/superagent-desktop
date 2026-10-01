import { describe, it, expect } from 'vitest'
import {
  agyDecision,
  agyToolCall,
  agyVerdict,
  classifyAgyTool,
  forgetHookCalls,
  hookSawStep,
  needsHook,
  noteHookCall,
  toAgyMode,
  type AgyMode
} from './approvals'

const MODES: AgyMode[] = ['bypassPermissions', 'acceptEdits', 'ask', 'plan']

const ownTool = { ServerName: 'cove-browser', ToolName: 'browser_navigate', Arguments: {} }

describe('what an Antigravity tool call may do without asking', () => {
  it('lets reading run in every mode', () => {
    for (const mode of MODES) {
      for (const tool of [
        'view_file',
        'list_dir',
        'grep_search',
        'search_web',
        'read_url_content'
      ]) {
        expect(agyVerdict(mode, tool, {})).toBe('allow')
      }
    }
  })

  it('lets Superagent’s own tools run in every mode, plan above all', () => {
    // Headless agy refuses any MCP call that would have prompted, which would
    // take the browser, the board and the simulator away outside Full access.
    for (const mode of MODES) expect(agyVerdict(mode, 'call_mcp_tool', ownTool)).toBe('allow')
  })

  it('does not extend that to somebody else’s MCP server', () => {
    const other = { ServerName: 'linear', ToolName: 'create_issue' }
    expect(classifyAgyTool('call_mcp_tool', other)).toBe('other')
    expect(agyVerdict('ask', 'call_mcp_tool', other)).toBe('ask')
    expect(agyVerdict('acceptEdits', 'call_mcp_tool', other)).toBe('ask')
    expect(agyVerdict('plan', 'call_mcp_tool', other)).toBe('deny')
    expect(agyVerdict('bypassPermissions', 'call_mcp_tool', other)).toBe('allow')
  })

  it('runs everything on full access', () => {
    for (const tool of ['run_command', 'write_to_file', 'replace_file_content', 'generate_image']) {
      expect(agyVerdict('bypassPermissions', tool, {})).toBe('allow')
      // No mode recorded is the app's default, which is full access.
      expect(agyVerdict(undefined, tool, {})).toBe('allow')
    }
  })

  it('accepts edits but asks before a command in acceptEdits', () => {
    expect(agyVerdict('acceptEdits', 'write_to_file', {})).toBe('allow')
    expect(agyVerdict('acceptEdits', 'multi_replace_file_content', {})).toBe('allow')
    expect(agyVerdict('acceptEdits', 'run_command', {})).toBe('ask')
  })

  it('asks before edits and commands in ask', () => {
    expect(agyVerdict('ask', 'replace_file_content', {})).toBe('ask')
    expect(agyVerdict('ask', 'run_command', {})).toBe('ask')
    expect(agyVerdict('ask', 'send_command_input', {})).toBe('ask')
  })

  it('lets nothing that changes the machine run in plan', () => {
    for (const tool of ['write_to_file', 'sed_file', 'run_command', 'generate_image']) {
      expect(agyVerdict('plan', tool, {})).toBe('deny')
    }
    // Delegating is still allowed: what a subagent does is judged call by call.
    expect(agyVerdict('plan', 'invoke_subagent', {})).toBe('allow')
  })

  it('lets the agent write its own notes, which is what plan mode is for', () => {
    const brain = '/home/.gemini/antigravity-cli/brain/conv-1'
    const plan = { TargetFile: `${brain}/implementation_plan.md` }
    for (const mode of MODES) expect(agyVerdict(mode, 'write_to_file', plan, brain)).toBe('allow')
    // A file of the user's is still a file of the user's, however it is spelled.
    expect(agyVerdict('plan', 'write_to_file', { TargetFile: '/work/a.ts' }, brain)).toBe('deny')
    expect(agyVerdict('plan', 'write_to_file', { TargetFile: `${brain}-other/x.md` }, brain)).toBe(
      'deny'
    )
    expect(agyVerdict('ask', 'write_to_file', { TargetFile: '/work/a.ts' }, brain)).toBe('ask')
  })

  it('treats an unreadable mode as full access rather than inventing a stricter one', () => {
    expect(toAgyMode('plan')).toBe('plan')
    expect(toAgyMode('ask')).toBe('ask')
    expect(toAgyMode('acceptEdits')).toBe('acceptEdits')
    expect(toAgyMode(null)).toBe('bypassPermissions')
    expect(toAgyMode('nonsense')).toBe('bypassPermissions')
  })
})

describe('checking that the hook really is the gate', () => {
  it('expects the hook to have been asked about anything the mode gates', () => {
    expect(needsHook('ask', 'run_command', {})).toBe(true)
    expect(needsHook('plan', 'write_to_file', { TargetFile: '/work/a.ts' })).toBe(true)
    expect(needsHook('acceptEdits', 'run_command', {})).toBe(true)
    // What the mode waves through proves nothing either way.
    expect(needsHook('acceptEdits', 'write_to_file', {})).toBe(false)
    expect(needsHook('ask', 'view_file', {})).toBe(false)
    // On full access there is no gate to check.
    expect(needsHook('bypassPermissions', 'run_command', {})).toBe(false)
    expect(needsHook(undefined, 'run_command', {})).toBe(false)
  })

  it('remembers which steps the hook was asked about, per chat', () => {
    noteHookCall('chat-a', 4)
    expect(hookSawStep('chat-a', 4)).toBe(true)
    expect(hookSawStep('chat-a', 5)).toBe(false)
    expect(hookSawStep('chat-b', 4)).toBe(false)
    forgetHookCalls('chat-a')
    expect(hookSawStep('chat-a', 4)).toBe(false)
    // A payload without a step number is not evidence of anything.
    noteHookCall('chat-a', null)
    expect(hookSawStep('chat-a', 0)).toBe(false)
  })
})

describe('reading the hook payload', () => {
  it('names the call the way the approval prompt and the injection gate know it', () => {
    const call = agyToolCall({
      conversationId: 'conv-1',
      stepIdx: 4,
      artifactDirectoryPath: '/home/.gemini/antigravity-cli/brain/conv-1',
      toolCall: { name: 'run_command', args: { CommandLine: 'rm -rf build' } }
    })
    expect(call).toEqual({
      raw: 'run_command',
      args: { CommandLine: 'rm -rf build' },
      name: 'Bash',
      input: { command: 'rm -rf build' },
      sessionId: 'conv-1',
      artifactDir: '/home/.gemini/antigravity-cli/brain/conv-1',
      stepIdx: 4
    })
  })

  it('gives a page read the name the injection gate taints a turn on', () => {
    const call = agyToolCall({
      conversationId: 'conv-1',
      toolCall: {
        name: 'call_mcp_tool',
        args: { ServerName: 'cove-browser', ToolName: 'browser_read_page', Arguments: {} }
      }
    })
    expect(call?.name).toBe('mcp__cove-browser__browser_read_page')
  })

  it('has nothing to say about a payload that names no tool', () => {
    expect(agyToolCall({})).toBeNull()
    expect(agyToolCall({ toolCall: {} })).toBeNull()
  })

  it('answers in the shape Antigravity reads', () => {
    expect(JSON.parse(agyDecision('allow'))).toEqual({ decision: 'allow' })
    expect(JSON.parse(agyDecision('deny', 'no'))).toEqual({ decision: 'deny', reason: 'no' })
  })
})
