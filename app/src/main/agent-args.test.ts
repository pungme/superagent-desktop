import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildAgentArgs } from './claude/session'

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

  it('blocks the schedulers that cannot reach Superagent, on every invocation', () => {
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

  it('gives an agent in a copy of a folder of repos the memory of the project', () => {
    // Claude Code files memory under the working directory. The copy is a
    // folder of its own, so without this each chat starts with none and loses
    // what it learned when the copy is removed.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'sa-args-')))
    try {
      const copy = join(root, '.worktrees', 'wt-1')
      mkdirSync(join(copy, 'api'), { recursive: true })
      writeFileSync(join(copy, 'api', '.git'), 'gitdir: elsewhere\n')
      mkdirSync(join(root, 'api', '.git'), { recursive: true }) // the repo it is a worktree of
      const args = buildAgentArgs({ cwd: copy })
      const settings = JSON.parse(valueAfter(args, '--settings')!)
      expect(settings.autoMemoryDirectory).toContain(
        `/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/memory`
      )
      expect(valueAfter(args, '--append-system-prompt')).toContain('`api`')
      // Still ahead of the variadic flag that would swallow it.
      expect(args.indexOf('--settings')).toBeLessThan(args.indexOf('--disallowedTools'))
      // A project folder, or a worktree of one repo, is left to Claude Code.
      expect(buildAgentArgs({ cwd: root })).not.toContain('--settings')
      expect(buildAgentArgs({ cwd: join(copy, 'api') })).not.toContain('--settings')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('pins an explicit model, with the next one down behind it', () => {
    expect(valueAfter(buildAgentArgs({ model: 'opus' }), '--model')).toBe('opus')
    expect(valueAfter(buildAgentArgs({ model: 'opus' }), '--fallback-model')).toBe('sonnet')
    const fable = buildAgentArgs({ model: 'claude-fable-5-1' })
    expect(valueAfter(fable, '--model')).toBe('claude-fable-5-1')
    expect(valueAfter(fable, '--fallback-model')).toBe('opus')
    // Nothing sensible below Sonnet to fall to unasked.
    expect(buildAgentArgs({ model: 'sonnet' }).includes('--fallback-model')).toBe(false)
    // Default is named: resuming without --model keeps the session's last
    // model, so a chat once on Fable stayed there under a "Default" pill.
    expect(valueAfter(buildAgentArgs({}), '--model')).toBe('default')
    expect(valueAfter(buildAgentArgs({ model: '' }), '--model')).toBe('default')
    expect(valueAfter(buildAgentArgs({}), '--fallback-model')).toBe('opus')
    expect(valueAfter(buildAgentArgs({ model: '' }), '--fallback-model')).toBe('opus')
  })

  it('keeps automatic fallback when resuming a Default session', () => {
    const args = buildAgentArgs({}, { resume: 'fable-session' })
    expect(valueAfter(args, '--fallback-model')).toBe('opus')
    expect(valueAfter(args, '--model')).toBe('default')
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

  it('ask mode maps to the default permission mode and names our prompt tool', () => {
    const args = buildAgentArgs({ permissionMode: 'ask' })
    const i = args.indexOf('--permission-mode')
    expect(args[i + 1]).toBe('default')
    const j = args.indexOf('--permission-prompt-tool')
    expect(args[j + 1]).toBe('mcp__cove-browser__permission_prompt')
  })
})

describe('a model whose allowance is used up', () => {
  it('starts chats on the next one down until the reset, then goes back', async () => {
    const { mkdtempSync, rmSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'cove-args-'))
    process.env.COVE_USER_DATA = dir
    const { markModelLimited, clearLimit, _resetAccountsForTests } = await import('./accounts')
    _resetAccountsForTests()
    try {
      markModelLimited('fable', Date.now() + 60_000)
      const args = buildAgentArgs({ model: 'claude-fable-5-1' })
      expect(valueAfter(args, '--model')).toBe('opus')
      expect(valueAfter(args, '--fallback-model')).toBe('sonnet')
      // Default resolves to Opus on the CLI's side: unaffected.
      expect(valueAfter(buildAgentArgs({}), '--model')).toBe('default')
      clearLimit('model:fable')
      expect(valueAfter(buildAgentArgs({ model: 'claude-fable-5-1' }), '--model')).toBe(
        'claude-fable-5-1'
      )
    } finally {
      _resetAccountsForTests()
      delete process.env.COVE_USER_DATA
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
