import { describe, it, expect } from 'vitest'
import { buildAgentArgs } from './agent'

/** The value that follows a flag, or undefined when the flag isn't there. */
function valueAfter(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag)
  return i === -1 ? undefined : args[i + 1]
}

describe('buildAgentArgs', () => {
  it('always streams both ways, so partial output can be rendered as it arrives', () => {
    const args = buildAgentArgs({})
    expect(valueAfter(args, '--output-format')).toBe('stream-json')
    expect(valueAfter(args, '--input-format')).toBe('stream-json')
    expect(args).toContain('--include-partial-messages')
  })

  it('defaults to bypassPermissions — under -p a prompt would be auto-denied', () => {
    expect(valueAfter(buildAgentArgs({}), '--permission-mode')).toBe('bypassPermissions')
  })

  it('honours a narrower permission mode when the user picked one', () => {
    expect(valueAfter(buildAgentArgs({ permissionMode: 'plan' }), '--permission-mode')).toBe('plan')
    expect(valueAfter(buildAgentArgs({ permissionMode: 'acceptEdits' }), '--permission-mode')).toBe(
      'acceptEdits'
    )
  })

  it('blocks the schedulers that cannot reach SuperAgent, on every invocation', () => {
    for (const opts of [{}, { model: 'opus' }, { browserProject: true }]) {
      const args = buildAgentArgs(opts)
      expect(args).toContain('CronCreate')
      expect(args).toContain('CronDelete')
      expect(args).toContain('CronList')
      expect(args).toContain('ScheduleWakeup')
    }
  })

  it('keeps --disallowedTools last, since it swallows everything after it', () => {
    // A flag landing after the variadic list would be read as a tool name, and
    // the option it belongs to would silently never apply.
    const args = buildAgentArgs({
      model: 'opus',
      browserProject: true,
      permissionMode: 'acceptEdits'
    })
    const i = args.indexOf('--disallowedTools')
    expect(i).toBeGreaterThan(-1)
    expect(args.slice(i + 1).some((a) => a.startsWith('--'))).toBe(false)
  })

  it('pins the model only when one was chosen', () => {
    expect(valueAfter(buildAgentArgs({ model: 'opus' }), '--model')).toBe('opus')
    // "Default" ('') sends no --model — the CLI resolves the account default.
    expect(buildAgentArgs({}).includes('--model')).toBe(false)
    expect(buildAgentArgs({ model: '' }).includes('--model')).toBe(false)
  })

  it('resumes in front of -p, where the CLI expects it', () => {
    const args = buildAgentArgs({}, { resume: 'sess-123' })
    expect(args[0]).toBe('--resume')
    expect(args[1]).toBe('sess-123')
    expect(buildAgentArgs({}, { resume: null }).includes('--resume')).toBe(false)
  })

  it('passes an MCP config only when there is one', () => {
    expect(valueAfter(buildAgentArgs({}, { mcpConfig: '/tmp/mcp.json' }), '--mcp-config')).toBe(
      '/tmp/mcp.json'
    )
    expect(buildAgentArgs({}).includes('--mcp-config')).toBe(false)
  })

  it('appends the browser briefing only for browser projects', () => {
    const withBrowser = valueAfter(
      buildAgentArgs({ browserProject: true }),
      '--append-system-prompt'
    )
    const without = valueAfter(buildAgentArgs({}), '--append-system-prompt')
    expect(withBrowser).toMatch(/browser pane/i)
    expect(without).not.toMatch(/browser pane/i)
    // The rest of the briefing is there either way.
    expect(without).toBeTruthy()
  })

  it('sends exactly one --append-system-prompt, not one per fragment', () => {
    const args = buildAgentArgs({ browserProject: true })
    expect(args.filter((a) => a === '--append-system-prompt')).toHaveLength(1)
  })

  it('builds valid arguments for Antigravity agent provider', () => {
    const args = buildAgentArgs(
      { agentProvider: 'antigravity', permissionMode: 'bypassPermissions' },
      { resume: 'conv-123' }
    )
    expect(valueAfter(args, '--output-format')).toBe('stream-json')
    expect(valueAfter(args, '--input-format')).toBe('stream-json')
    expect(args).toContain('--dangerously-skip-permissions')
    expect(valueAfter(args, '--conversation')).toBe('conv-123')
  })

  it('maps permission modes correctly for Antigravity', () => {
    const acceptEdits = buildAgentArgs({
      agentProvider: 'antigravity',
      permissionMode: 'acceptEdits'
    })
    expect(valueAfter(acceptEdits, '--mode')).toBe('accept-edits')

    const plan = buildAgentArgs({ agentProvider: 'antigravity', permissionMode: 'plan' })
    expect(valueAfter(plan, '--mode')).toBe('plan')
  })
})
