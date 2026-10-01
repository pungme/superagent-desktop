import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hookCommand, removeSidecar, shellQuote, sidecarName, writeSidecar } from './sidecar'

describe('the session folder', () => {
  it('names Superagent’s tool server the way Antigravity reads it', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'agy-sidecar-')), 'chat-1')
    writeSidecar({ dir, mcpUrl: 'http://127.0.0.1:5000/mcp?ws=w1&chat=c1' })
    const config = JSON.parse(readFileSync(join(dir, '.agents', 'mcp_config.json'), 'utf8'))
    // `serverUrl`: Antigravity ignores the `url` field the other agents use.
    expect(config).toEqual({
      mcpServers: {
        'cove-browser': { serverUrl: 'http://127.0.0.1:5000/mcp?ws=w1&chat=c1', disabled: false }
      }
    })
  })

  it('installs one hook that asks before every tool, in the chat’s mode', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'agy-sidecar-')), 'chat-1')
    writeSidecar({
      dir,
      hookUrl: 'http://127.0.0.1:6000/hook/secret',
      workspaceId: 'w1',
      chatId: 'c1',
      mode: 'ask'
    })
    const hooks = JSON.parse(readFileSync(join(dir, '.agents', 'hooks.json'), 'utf8'))
    const [group] = hooks['superagent-approvals'].PreToolUse
    expect(group.matcher).toBe('*')
    expect(group.hooks[0].command).toContain(
      'http://127.0.0.1:6000/hook/secret/AgyPreToolUse?mode=ask&chat=c1'
    )
    expect(group.hooks[0].command).toContain('x-cove-workspace: w1')
    // Longer than the app's own wait for a person to answer.
    expect(group.hooks[0].timeout).toBeGreaterThanOrEqual(600)
  })

  it('installs no hook when there is no hook server to ask', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'agy-sidecar-')), 'chat-1')
    writeSidecar({ dir, mcpUrl: 'http://127.0.0.1:5000/mcp' })
    expect(JSON.parse(readFileSync(join(dir, '.agents', 'hooks.json'), 'utf8'))).toEqual({})
  })

  it('keeps the launch’s secrets readable by the user alone', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'agy-sidecar-')), 'chat-1')
    writeSidecar({ dir, mcpUrl: 'http://127.0.0.1:5000/mcp', hookUrl: 'http://127.0.0.1:6000/h' })
    expect(statSync(join(dir, '.agents', 'mcp_config.json')).mode & 0o777).toBe(0o600)
    expect(statSync(join(dir, '.agents', 'hooks.json')).mode & 0o777).toBe(0o600)
  })

  it('is rewritten in place and goes away whole', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'agy-sidecar-')), 'chat-1')
    writeSidecar({ dir, mcpUrl: 'http://127.0.0.1:1/mcp' })
    writeSidecar({ dir, mcpUrl: 'http://127.0.0.1:2/mcp' })
    const config = JSON.parse(readFileSync(join(dir, '.agents', 'mcp_config.json'), 'utf8'))
    expect(config.mcpServers['cove-browser'].serverUrl).toBe('http://127.0.0.1:2/mcp')
    removeSidecar(dir)
    expect(existsSync(dir)).toBe(false)
    // Removing what is already gone is not an error.
    removeSidecar(dir)
  })

  it('turns any id into one safe path segment', () => {
    expect(sidecarName('ws/../../etc:chat 1')).toBe('ws_.._.._etc_chat_1')
    expect(sidecarName('')).toBe('session')
  })
})

describe('the hook command', () => {
  it('quotes so nothing in a value is read as shell syntax', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`)
    const command = hookCommand('http://127.0.0.1:6000/hook/s', "w'; rm -rf ~ #", 'plan')
    // sh parses it as one curl with the hostile id inside a single argument.
    const curl = command.slice(0, command.indexOf(' 2>/dev/null')).replace(/^curl/, '')
    const argv = execFileSync('sh', ['-c', `printf '%s\\n' ${curl}`], {
      encoding: 'utf8'
    })
      .trim()
      .split('\n')
    expect(argv).toContain("x-cove-workspace: w'; rm -rf ~ #")
    expect(argv[argv.length - 1]).toBe('http://127.0.0.1:6000/hook/s/AgyPreToolUse?mode=plan')
  })

  it('hands the payload over on stdin and prints the verdict', () => {
    const command = hookCommand('http://127.0.0.1:6000/hook/s', 'w1', 'ask')
    expect(command).toContain('--data-binary @-')
    expect(command).toContain('-X POST')
  })

  // The CLI runs with everything approved and the hook is the only gate, so
  // what the hook says when it cannot reach Superagent decides what is safe.
  const unreachable = (mode: 'ask' | 'plan' | 'acceptEdits' | 'bypassPermissions'): unknown =>
    JSON.parse(
      execFileSync('sh', ['-c', hookCommand('http://127.0.0.1:1/hook/s', 'w1', mode)], {
        input: '{"toolCall":{"name":"run_command","args":{}}}',
        encoding: 'utf8'
      })
    )

  it('refuses on its own when Superagent cannot be reached, in every mode it gates', () => {
    for (const mode of ['ask', 'plan', 'acceptEdits'] as const) {
      expect(unreachable(mode)).toMatchObject({ decision: 'deny' })
    }
  })

  it('gets out of the way on full access, where there is nothing to gate', () => {
    expect(unreachable('bypassPermissions')).toEqual({ decision: 'allow' })
  })
})
