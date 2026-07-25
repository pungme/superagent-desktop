import { ipcMain, WebContents } from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
import os from 'os'
import { getHookUrl } from './hooks'
import { getMcpUrl, writeWorkspaceMcpConfig } from './mcp'
import { findClaude } from './claude-cli'

/**
 * "Easy mode" — drives the real `claude` binary in streaming-JSON mode so we can
 * render a clean chat UI instead of the terminal TUI. Same binary, same
 * subscription; we just parse the event stream and forward it to the renderer.
 *
 * Multi-turn: claude runs with --input-format stream-json, staying alive and
 * reading one JSON user message per line from stdin.
 */

interface AgentSession {
  id: string
  proc: ChildProcessWithoutNullStreams
  owner: WebContents
  buffer: string
}

const sessions = new Map<string, AgentSession>()

export interface AgentStartOptions {
  cwd?: string
  workspaceId?: string
  mcpConfigPath?: string
}

export function startAgent(owner: WebContents, opts: AgentStartOptions): string {
  const id = randomUUID()
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose'
  ]
  const mcpConfig =
    opts.mcpConfigPath || (opts.workspaceId ? writeWorkspaceMcpConfig(opts.workspaceId) : undefined)
  if (mcpConfig) args.push('--mcp-config', mcpConfig)

  const proc = spawn(findClaude(), args, {
    cwd: opts.cwd || os.homedir(),
    env: {
      ...process.env,
      COVE_HOOK_URL: getHookUrl(),
      COVE_MCP_URL: getMcpUrl(),
      ...(opts.workspaceId ? { COVE_WORKSPACE_ID: opts.workspaceId } : {})
    },
    // Login shell resolves the user's PATH (nvm/homebrew/~/.local/bin).
    shell: false
  }) as ChildProcessWithoutNullStreams

  const session: AgentSession = { id, proc, owner, buffer: '' }
  sessions.set(id, session)

  proc.stdout.on('data', (chunk: Buffer) => {
    session.buffer += chunk.toString('utf8')
    let nl: number
    while ((nl = session.buffer.indexOf('\n')) >= 0) {
      const line = session.buffer.slice(0, nl).trim()
      session.buffer = session.buffer.slice(nl + 1)
      if (!line) continue
      try {
        const event = JSON.parse(line)
        if (!owner.isDestroyed()) owner.send(`agent:event:${id}`, event)
      } catch {
        // partial or non-JSON line; ignore
      }
    }
  })

  proc.stderr.on('data', (chunk: Buffer) => {
    if (!owner.isDestroyed()) owner.send(`agent:stderr:${id}`, chunk.toString('utf8'))
  })

  proc.on('exit', (code) => {
    sessions.delete(id)
    if (!owner.isDestroyed()) owner.send(`agent:exit:${id}`, code ?? 0)
  })

  return id
}

export function sendToAgent(id: string, text: string): void {
  const session = sessions.get(id)
  if (!session) return
  const message = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] }
  }
  session.proc.stdin.write(JSON.stringify(message) + '\n')
}

/** Interrupt the current generation without ending the session (keeps context). */
export function interruptAgent(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  const control = {
    type: 'control_request',
    request_id: randomUUID(),
    request: { subtype: 'interrupt' }
  }
  session.proc.stdin.write(JSON.stringify(control) + '\n')
}

export function stopAgent(id: string): void {
  const session = sessions.get(id)
  if (session) {
    sessions.delete(id)
    session.proc.kill()
  }
}

export function killAllAgents(): void {
  for (const id of [...sessions.keys()]) stopAgent(id)
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:start', (e, opts: AgentStartOptions) => startAgent(e.sender, opts))
  ipcMain.on('agent:send', (_e, id: string, text: string) => sendToAgent(id, text))
  ipcMain.on('agent:interrupt', (_e, id: string) => interruptAgent(id))
  ipcMain.on('agent:stop', (_e, id: string) => stopAgent(id))
}
