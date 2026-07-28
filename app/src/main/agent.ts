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
  killed?: boolean
}

const sessions = new Map<string, AgentSession>()

export interface AgentStartOptions {
  cwd?: string
  workspaceId?: string
  mcpConfigPath?: string
  /** Resume a prior conversation by session id (so history/context persists). */
  resumeSessionId?: string | null
  /** Browser-first workspace: steer Claude to drive the visible browser. */
  browserProject?: boolean
}

const BROWSER_SYSTEM_PROMPT =
  'You are working inside SuperAgent, a desktop app with a live Chromium browser pane open and ' +
  'visible to the user, right next to this chat. To browse the web or interact with ANY ' +
  'website, use the cove-browser tools (browser_navigate, browser_read_page, browser_click, ' +
  'browser_type, browser_press_key, browser_screenshot, browser_wait_for) — they drive the ' +
  'actual visible browser so the user can watch. You can drive real websites, not just ' +
  'localhost. Strongly prefer these tools over WebSearch and WebFetch. To run a web search, ' +
  'navigate the browser to the search engine and type the query rather than calling WebSearch.'

// Scheduling MUST go through SuperAgent's own routines — cloud/loop schedulers run
// elsewhere and can't reach this browser or the user's logged-in session.
const SCHEDULING_PROMPT =
  'To run something on a schedule or repeatedly for this project (e.g. "every 30 minutes…", ' +
  '"each morning…", "keep doing this"), use the create_routine tool. It re-runs the task inside ' +
  "SuperAgent — for a browser project, against THIS browser with the user's logged-in session — " +
  'on a timer while SuperAgent is open. Do NOT use CronCreate, the /loop skill, ScheduleWakeup, or ' +
  'any external/cloud scheduler for this: those run elsewhere and cannot see or drive SuperAgent, ' +
  "its browser, or the user's session, so the task would silently never touch this page. " +
  'Before creating a routine, call list_routines to see what already exists — if one already covers ' +
  'the task, update it by calling delete_routine on the old one and create_routine with the new ' +
  'wording, rather than leaving two routines that both fire. ' +
  "create_routine's minimum interval is 60 minutes — if the user asks for less, tell them you are " +
  'using 60 and continue.'

export function startAgent(owner: WebContents, opts: AgentStartOptions): string {
  const id = randomUUID()
  const mcpConfig =
    opts.mcpConfigPath || (opts.workspaceId ? writeWorkspaceMcpConfig(opts.workspaceId) : undefined)

  // A valid resume emits a `system/init` event; a missing session makes claude
  // exit having only emitted SessionStart *hook* events (which fire before the
  // session is validated). So we track the init event specifically — not any
  // stdout — to tell a successful start from a failed resume, and only fall back
  // to a fresh session when a resume never reached init.
  let sawInit = false

  const spawnProc = (resume: string | null): void => {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose'
    ]
    if (resume) args.unshift('--resume', resume)
    if (mcpConfig) args.push('--mcp-config', mcpConfig)
    const appended = [SCHEDULING_PROMPT, opts.browserProject ? BROWSER_SYSTEM_PROMPT : '']
      .filter(Boolean)
      .join(' ')
    args.push('--append-system-prompt', appended)
    // Hard stop: cloud/loop schedulers can't reach SuperAgent's browser, so scheduling
    // must use create_routine. Unknown tool names here are harmless no-ops.
    args.push('--disallowedTools', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup')

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

    // Writing to a claude that has already closed stdin throws EPIPE; without a
    // listener that becomes an unhandled 'error' and crashes the main process.
    proc.stdin.on('error', () => {})

    proc.stdout.on('data', (chunk: Buffer) => {
      session.buffer += chunk.toString('utf8')
      let nl: number
      while ((nl = session.buffer.indexOf('\n')) >= 0) {
        const line = session.buffer.slice(0, nl).trim()
        session.buffer = session.buffer.slice(nl + 1)
        if (!line) continue
        try {
          const event = JSON.parse(line)
          if (event?.type === 'system' && event?.subtype === 'init') sawInit = true
          if (!owner.isDestroyed()) owner.send(`agent:event:${id}`, event)
        } catch {
          // partial or non-JSON line; ignore
        }
      }
    })

    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      if (!owner.isDestroyed()) owner.send(`agent:stderr:${id}`, chunk.toString('utf8'))
    })

    // spawn failures (e.g. ENOENT when the binary can't be found) emit 'error',
    // not 'exit'; without this handler that's an unhandled error on the child.
    proc.on('error', (err) => {
      console.error('[agent] spawn error:', err.message)
      sessions.delete(id)
      if (session.killed) return
      if (resume && !sawInit) {
        spawnProc(null)
        return
      }
      if (!owner.isDestroyed()) owner.send(`agent:exit:${id}`, 1)
    })

    proc.on('exit', (code) => {
      sessions.delete(id)
      if (code && code !== 0 && stderr) console.error('[agent] exited', code, stderr.slice(0, 300))
      if (session.killed) return
      if (resume && !sawInit) {
        // The resume target was unavailable (claude exited before emitting
        // anything) — retry once with a fresh session.
        spawnProc(null)
        return
      }
      if (!owner.isDestroyed()) owner.send(`agent:exit:${id}`, code ?? 0)
    })
  }

  spawnProc(opts.resumeSessionId ?? null)
  return id
}

export interface AgentImage {
  mediaType: string
  data: string // base64
}

export function sendToAgent(id: string, text: string, images: AgentImage[] = []): void {
  const session = sessions.get(id)
  if (!session || !session.proc.stdin.writable) return
  const content = [
    ...images.map((im) => ({
      type: 'image',
      source: { type: 'base64', media_type: im.mediaType, data: im.data }
    })),
    ...(text ? [{ type: 'text', text }] : [])
  ]
  const message = { type: 'user', message: { role: 'user', content } }
  session.proc.stdin.write(JSON.stringify(message) + '\n')
}

/** Interrupt the current generation without ending the session (keeps context). */
export function interruptAgent(id: string): void {
  const session = sessions.get(id)
  if (!session || !session.proc.stdin.writable) return
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
    session.killed = true // don't trigger the resume→fresh fallback on a deliberate stop
    sessions.delete(id)
    session.proc.kill()
  }
}

export function killAllAgents(): void {
  for (const id of [...sessions.keys()]) stopAgent(id)
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:start', (e, opts: AgentStartOptions) => startAgent(e.sender, opts))
  ipcMain.on('agent:send', (_e, id: string, text: string, images?: AgentImage[]) =>
    sendToAgent(id, text, images ?? [])
  )
  ipcMain.on('agent:interrupt', (_e, id: string) => interruptAgent(id))
  ipcMain.on('agent:stop', (_e, id: string) => stopAgent(id))
}
