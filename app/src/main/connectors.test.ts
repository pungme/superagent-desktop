import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * claude.ai connectors per Claude account: read from `claude mcp list` (a fake
 * CLI here), their ids from /v1/mcp_servers (a fake fetch), and the words a
 * turn uses when one needs signing in. Nothing real is run or reached.
 */

const h = vi.hoisted(() => ({ bin: '', broadcasts: [] as unknown[][] }))

vi.mock('electron', () => ({
  app: { getPath: () => process.env.COVE_USER_DATA },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('./util', () => ({
  broadcastToWindows: (...a: unknown[]) => h.broadcasts.push(a)
}))
vi.mock('./claude-cli', () => ({
  findClaude: () => h.bin,
  findCodex: () => 'codex',
  findAgy: () => 'agy',
  agentEnv: (_b: string, env = process.env) => env
}))
vi.mock('./agent-signin', () => ({ signInAgent: vi.fn() }))
vi.mock('./browser', () => ({ applyBrowserIdentity: () => {} }))

import {
  connectFinished,
  connectorId,
  connectorsAskedFor,
  connectStartUrl,
  knownConnectors,
  listConnectors,
  orgOf,
  parseMcpList
} from './connectors'
import { _resetAccountsForTests, addClaudeToken, LOGIN_ID } from './accounts'

/** What `claude mcp list` printed for the user's own login (2.1.314, 2026-11-03). */
const LISTED = `Checking MCP server health…

claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected
claude.ai Superhuman Mail: https://mcp.mail.superhuman.com/mcp - ! Needs authentication
claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - ✔ Connected
claude.ai Attio: https://mcp.attio.com/mcp - ! Needs authentication
linear: https://mcp.linear.app/sse (SSE) - ✔ Connected
claude.ai Broken: https://x.example/mcp - ✗ Failed to connect
`

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cove-connectors-'))
  process.env.COVE_USER_DATA = dir
  process.env.HOME = join(dir, 'home')
  mkdirSync(process.env.HOME)
  h.bin = join(dir, 'claude')
  h.broadcasts.length = 0
  _resetAccountsForTests()
})
const realHome = process.env.HOME
afterEach(() => {
  process.env.HOME = realHome
  rmSync(dir, { recursive: true, force: true })
})

describe('reading them', () => {
  it('takes the claude.ai ones out of `claude mcp list`, with whether each is connected', () => {
    expect(parseMcpList(LISTED)).toEqual([
      { name: 'Claude Docs', url: 'https://api.anthropic.com/v1/pages/mcp', status: 'connected' },
      {
        name: 'Superhuman Mail',
        url: 'https://mcp.mail.superhuman.com/mcp',
        status: 'needs-auth'
      },
      { name: 'Gmail', url: 'https://gmailmcp.googleapis.com/mcp/v1', status: 'connected' },
      { name: 'Attio', url: 'https://mcp.attio.com/mcp', status: 'needs-auth' },
      { name: 'Broken', url: 'https://x.example/mcp', status: 'failed' }
    ])
    expect(parseMcpList('')).toEqual([])
  })

  it('runs the CLI as the account, and not at all for a token account', async () => {
    // The fake says which config folder it was run with.
    writeFileSync(
      h.bin,
      `#!/bin/sh\n[ "$1 $2" = "mcp list" ] || exit 2\necho "claude.ai Attio: https://mcp.attio.com/mcp - ! Needs authentication"\necho "claude.ai Dir\${CLAUDE_CONFIG_DIR:-none}: https://x - ✔ Connected"\n`
    )
    chmodSync(h.bin, 0o755)
    const list = await listConnectors(LOGIN_ID.claude)
    expect(list.map((c) => c.name)).toEqual(['Attio', 'Dirnone'])
    expect(knownConnectors(LOGIN_ID.claude)[0].status).toBe('needs-auth')
    expect(h.broadcasts).toEqual([['connectors:changed', LOGIN_ID.claude]])
    const token = addClaudeToken('Work', 'sk-ant-oat01-' + 'a'.repeat(40))
    expect(await listConnectors(token.id)).toEqual([])
  })

  it('finds a connector’s id by its name, and builds claude.ai’s start-auth address', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        data: [
          { id: 'mcpsrv_01Shm', display_name: 'Superhuman Mail' },
          { id: 'mcpsrv_01Att', display_name: 'Attio' }
        ]
      })
    })) as unknown as typeof fetch
    expect(await connectorId('tok', 'Attio', fetcher)).toBe('mcpsrv_01Att')
    expect(await connectorId('tok', 'Nope', fetcher)).toBeNull()
    const [, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock
      .calls[0]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect((init.headers as Record<string, string>)['anthropic-beta']).toBe(
      'mcp-servers-2025-12-04'
    )
    expect(connectStartUrl('org-1', 'mcprs_01Att')).toBe(
      'https://claude.ai/api/organizations/org-1/mcp/start-auth/mcpsrv_01Att?product_surface=cli'
    )
    const cfg = join(dir, 'c.json')
    writeFileSync(cfg, JSON.stringify({ oauthAccount: { organizationUuid: 'org-9' } }))
    expect(orgOf(cfg)).toBe('org-9')
    expect(orgOf(join(dir, 'missing.json'))).toBeNull()
  })
})

describe('a turn that needed one', () => {
  const tool = (text: string): Record<string, unknown> => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] }
  })
  const said = (text: string): Record<string, unknown> => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] }
  })

  it('hears Claude Code’s own words for it', () => {
    expect(
      connectorsAskedFor(
        tool(
          'This is a claude.ai MCP connector. Ask the user to run /mcp and select "claude.ai Superhuman Mail" to authenticate.'
        ),
        ['Superhuman Mail']
      )
    ).toEqual(['Superhuman Mail'])
    expect(
      connectorsAskedFor(
        tool('Needs authentication (ask the user to run /mcp): claude.ai Attio, claude.ai Slack'),
        ['Attio', 'Slack']
      )
    ).toEqual(['Attio', 'Slack'])
  })

  it('never from a file the agent read, or for a name the account does not have', () => {
    // The agent read connectors.ts, which quotes these patterns.
    const source = tool(
      'matchAll(/run \\/mcp and select "([^"]+)" to authenticate/g)\n' +
        "tool('Needs authentication (ask the user to run /mcp): X, A, B\")'\n" +
        'Superhuman Mail is not connected'
    )
    expect(connectorsAskedFor(source, ['Superhuman Mail'])).toEqual([])
    expect(
      connectorsAskedFor(tool('Needs authentication (ask the user to run /mcp): X, A'), ['Attio'])
    ).toEqual([])
  })

  it('and the agent’s, only for a connector known to need it', () => {
    expect(
      connectorsAskedFor(said('Superhuman Mail needs to be authenticated before I can read it.'), [
        'Superhuman Mail'
      ])
    ).toEqual(['Superhuman Mail'])
    expect(connectorsAskedFor(said('I read your Gmail inbox.'), ['Superhuman Mail'])).toEqual([])
    expect(connectorsAskedFor(said('Gmail is not connected.'), ['Superhuman Mail'])).toEqual([])
    expect(connectorsAskedFor({ type: 'result' }, ['Superhuman Mail'])).toEqual([])
  })
})

describe('when a connect window is done', () => {
  it('after going to the service and coming back to claude.ai', () => {
    const start =
      'https://claude.ai/api/organizations/o/mcp/start-auth/mcpsrv_1?product_surface=cli'
    expect(connectFinished([start])).toBe(false)
    expect(connectFinished([start, 'https://claude.ai/login?returnTo=x'])).toBe(false)
    expect(connectFinished([start, 'https://app.attio.com/oauth/authorize'])).toBe(false)
    expect(
      connectFinished([
        start,
        'https://app.attio.com/oauth/authorize',
        'https://claude.ai/api/mcp/auth_callback?code=1'
      ])
    ).toBe(false)
    expect(
      connectFinished([
        start,
        'https://app.attio.com/oauth/authorize',
        'https://claude.ai/settings/connectors?server=mcpsrv_1'
      ])
    ).toBe(true)
  })
})
