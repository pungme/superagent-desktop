import { ipcMain, WebContents } from 'electron'
import * as pty from 'node-pty'
import { randomUUID } from 'crypto'
import os from 'os'
import { getHookUrl } from './hooks'
import { getMcpUrl, writeWorkspaceMcpConfig } from './mcp'

export interface PtyCreateOptions {
  cwd?: string
  cols: number
  rows: number
  /** Command to run instead of the login shell (e.g. `claude`). Runs inside the shell so PATH/env are right. */
  command?: string
  env?: Record<string, string>
  /** Workspace this terminal belongs to — surfaced to Claude Code hooks. */
  workspaceId?: string
}

interface PtySession {
  id: string
  proc: pty.IPty
  owner: WebContents
}

const sessions = new Map<string, PtySession>()

function defaultShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

export function createPty(owner: WebContents, opts: PtyCreateOptions): string {
  const id = randomUUID()
  const shell = defaultShell()

  // For a Cove-launched claude in a workspace, inject the per-workspace MCP config
  // so Claude can drive that workspace's browser pane.
  let command = opts.command
  if (command && opts.workspaceId && /^claude(\s|$)/.test(command.trim())) {
    const configPath = writeWorkspaceMcpConfig(opts.workspaceId)
    command = `${command} --mcp-config ${JSON.stringify(configPath)}`
  }

  // -l → login shell so the user's real PATH (nvm, homebrew, ~/.local/bin) is loaded.
  // -i + -c lets us drop straight into a command (like `claude`) while keeping that env.
  const args = command ? ['-il', '-c', command] : ['-l']

  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd || os.homedir(),
    env: {
      ...process.env,
      ...opts.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      TERM_PROGRAM: 'Cove',
      // Surfaced to Claude Code hooks + the browser MCP server so this session
      // reports status to Cove and can drive its own workspace's browser pane.
      COVE_HOOK_URL: getHookUrl(),
      COVE_MCP_URL: getMcpUrl(),
      ...(opts.workspaceId ? { COVE_WORKSPACE_ID: opts.workspaceId } : {})
    } as Record<string, string>
  })

  const session: PtySession = { id, proc, owner }
  sessions.set(id, session)

  proc.onData((data) => {
    if (!owner.isDestroyed()) owner.send(`pty:data:${id}`, data)
  })
  proc.onExit(({ exitCode }) => {
    sessions.delete(id)
    if (!owner.isDestroyed()) owner.send(`pty:exit:${id}`, exitCode)
  })

  return id
}

export function killPty(id: string): void {
  const s = sessions.get(id)
  if (s) {
    sessions.delete(id)
    s.proc.kill()
  }
}

export function killAllPtys(): void {
  for (const id of [...sessions.keys()]) killPty(id)
}

export function registerPtyIpc(): void {
  ipcMain.handle('pty:create', (e, opts: PtyCreateOptions) => createPty(e.sender, opts))
  ipcMain.on('pty:write', (_e, id: string, data: string) => {
    sessions.get(id)?.proc.write(data)
  })
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) sessions.get(id)?.proc.resize(cols, rows)
  })
  ipcMain.on('pty:kill', (_e, id: string) => killPty(id))
}
