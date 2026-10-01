import { describe, it, expect, beforeAll } from 'vitest'
import { exec } from 'child_process'
import { startHookServer } from '../hooks'
import { hookCommand } from './sidecar'

/**
 * The hook Antigravity runs before every tool is `curl` to this endpoint (see
 * sidecar.ts), so what the endpoint answers is what the agent is allowed to do.
 * Only the verdicts that need nobody to answer are exercised here; the ones that
 * ask go through the same approval prompt Claude Code's and Codex's do.
 */
let base = ''

beforeAll(async () => {
  base = await startHookServer()
})

async function ask(
  mode: string,
  toolCall: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/AgyPreToolUse?mode=${mode}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cove-workspace': 'w1' },
    body: JSON.stringify({ conversationId: 'conv-endpoint', stepIdx: 3, toolCall })
  })
  expect(res.status).toBe(200)
  return (await res.json()) as Record<string, unknown>
}

describe('the Antigravity tool hook endpoint', () => {
  it('lets everything through on full access', async () => {
    expect(
      await ask('bypassPermissions', { name: 'run_command', args: { CommandLine: 'npm test' } })
    ).toEqual({ decision: 'allow' })
  })

  it('refuses a command in plan mode, and says why in words the agent can use', async () => {
    const verdict = await ask('plan', { name: 'run_command', args: { CommandLine: 'rm -rf x' } })
    expect(verdict.decision).toBe('deny')
    expect(String(verdict.reason)).toMatch(/plan mode/i)
  })

  it('refuses an edit in plan mode but still lets the agent read', async () => {
    expect(
      (await ask('plan', { name: 'write_to_file', args: { TargetFile: '/a' } })).decision
    ).toBe('deny')
    expect(await ask('plan', { name: 'view_file', args: { AbsolutePath: '/a' } })).toEqual({
      decision: 'allow'
    })
  })

  it('allows Superagent’s own tools in the modes where agy would refuse every MCP call', async () => {
    for (const mode of ['ask', 'acceptEdits', 'plan']) {
      expect(
        await ask(mode, {
          name: 'call_mcp_tool',
          args: { ServerName: 'cove-browser', ToolName: 'board_list', Arguments: {} }
        })
      ).toEqual({ decision: 'allow' })
    }
  })

  it('accepts an edit without asking in acceptEdits', async () => {
    expect(
      await ask('acceptEdits', { name: 'replace_file_content', args: { TargetFile: '/a.ts' } })
    ).toEqual({ decision: 'allow' })
  })

  it('answers the very command the hook runs, payload in on stdin and verdict out on stdout', async () => {
    // Exactly what Antigravity does with hooks.json: run the command in a shell,
    // write its JSON to stdin, read the decision off stdout.
    const run = (mode: 'plan' | 'bypassPermissions'): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = exec(hookCommand(base, 'w1', mode), (err, stdout) =>
          err ? reject(err) : resolve(stdout)
        )
        child.stdin?.end(
          JSON.stringify({
            conversationId: 'conv-endpoint',
            toolCall: { name: 'run_command', args: { CommandLine: 'ls' } }
          })
        )
      })
    expect(JSON.parse(await run('plan')).decision).toBe('deny')
    expect(JSON.parse(await run('bypassPermissions'))).toEqual({ decision: 'allow' })
  })

  it('never wedges the agent on a payload it cannot read', async () => {
    const res = await fetch(`${base}/AgyPreToolUse?mode=plan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json'
    })
    expect(await res.json()).toEqual({ decision: 'allow' })
  })
})
