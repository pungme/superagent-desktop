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
  /**
   * How much the agent may do without asking. Only modes that need no prompt
   * are offered: under -p there is nowhere to answer one, so anything that
   * would ask is auto-denied and the tool silently fails.
   */
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan'
  /** Model to run on (e.g. 'opus', 'sonnet'); '' / undefined = Claude's default. */
  model?: string
}

const BROWSER_SYSTEM_PROMPT =
  'You are working inside SuperAgent, a desktop app with a live Chromium browser pane open and ' +
  'visible to the user, right next to this chat. To browse the web or interact with ANY ' +
  'website, use the cove-browser tools (browser_navigate, browser_read_page, browser_click, ' +
  'browser_type, browser_press_key, browser_screenshot, browser_wait_for) — they drive the ' +
  'actual visible browser so the user can watch. You can drive real websites, not just ' +
  'localhost. Strongly prefer these tools over WebSearch and WebFetch. To run a web search, ' +
  'navigate the browser to the search engine and type the query rather than calling WebSearch.'

// SuperAgent surfaces Claude's task list in its Tasks panel by watching the
// TaskCreate/TaskUpdate tools (this build has no TodoWrite). Nudge Claude to keep
// that list current so the panel reflects real progress.
const TODO_PROMPT =
  'When you plan or track a multi-step task, use your task-tracking tools: TaskCreate to add each ' +
  'step and TaskUpdate to move it through in_progress → completed. SuperAgent shows that list to ' +
  'the user live in its Tasks panel, so create the tasks up front and keep their status current as ' +
  'you work.'

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
  'Only create a routine you would actually be willing to carry out yourself each run — apply the ' +
  'same judgment at create time as you would when running it. In particular, do NOT create a ' +
  "routine whose purpose is to make automated activity look human or evade a platform's " +
  'anti-automation or bot-detection systems (e.g. randomizing actions "so the pattern doesn\'t look ' +
  'automated"); say plainly that you won\'t and why, instead of creating a routine that will just ' +
  'decline on every run. ' +
  "create_routine's minimum interval is 60 minutes — if the user asks for less, tell them you are " +
  'using 60 and continue.'

// Headless `claude -p` has no AskUserQuestion tool, so SuperAgent gives Claude a
// plain-text convention instead: a ```ask fenced block renders as clickable
// options in the chat, and the user's pick returns as their next message.
const CHOICES_PROMPT =
  'When you want the user to choose between a few concrete options — a decision point, a ' +
  'preference, a this-or-that — you MAY offer clickable choices by ending your message with a ' +
  'fenced code block tagged `ask` containing a single JSON object: ' +
  '{"question": string, "multiple": boolean, "options": [{"label": string, "hint"?: string}]}. ' +
  'Set "multiple": true when several options can be picked together. Keep labels short; put any ' +
  "extra explanation in \"hint\". SuperAgent renders these as buttons and sends the user's " +
  'selection back as their next message. Use this only for genuine small multiple-choice decisions ' +
  '(2–4 options); for anything open-ended, just ask in prose as normal. Example:\n' +
  '```ask\n{"question": "Which theme?", "multiple": false, "options": [{"label": "Dark"}, ' +
  '{"label": "Light"}, {"label": "Match system", "hint": "Follow macOS appearance"}]}\n```'

// Files the user should see belong INSIDE SuperAgent, not a separate OS window.
const FILE_OPEN_PROMPT =
  'When the user asks you to open or show them a file (a PDF, an image, a document, ' +
  'a markdown/text/code file), use the open_file tool — it displays the file inside ' +
  'SuperAgent (the in-app viewer for text/markdown/code, the preview pane for PDFs and ' +
  'images), right next to this chat. Do NOT use the shell `open` (macOS) or `xdg-open` ' +
  'command to launch a file in an external app when open_file can show it in-app; only ' +
  'fall back to the shell for file types SuperAgent cannot display (e.g. .docx, .xlsx, archives).'

/**
 * Kill every session a renderer owns. A reload tears the page down without running
 * React's effect cleanups, so the chats never get to call agent:stop and their
 * `claude` processes are orphaned — alive, idle on stdin, and unreachable, since
 * the new page has no idea they exist. Left alone each reload (or renderer crash)
 * strands one process per open chat for the life of the app.
 */
function killSessionsOwnedBy(owner: WebContents): void {
  for (const [id, session] of [...sessions]) {
    if (session.owner === owner) stopAgent(id)
  }
}

/** Renderers we've already wired the teardown handlers onto. */
const watchedOwners = new WeakSet<WebContents>()

function watchOwner(owner: WebContents): void {
  if (watchedOwners.has(owner)) return
  watchedOwners.add(owner)
  // A reload or a navigation away replaces the page that owned these sessions.
  // Same-document navigations (hash changes) keep the page, so they're excluded.
  owner.on('did-start-navigation', (_e, _url, _isInPlace, isMainFrame) => {
    if (isMainFrame) killSessionsOwnedBy(owner)
  })
  owner.on('render-process-gone', () => killSessionsOwnedBy(owner))
  owner.on('destroyed', () => killSessionsOwnedBy(owner))
}

export function startAgent(owner: WebContents, opts: AgentStartOptions): string {
  watchOwner(owner)
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
      '--verbose',
      // Under -p there is no interactive prompt, so anything needing approval is
      // auto-denied — Edit/Write silently fail while reads succeed. The default
      // gives the agent the same reach it has in a terminal session where the
      // user approves prompts themselves. --disallowedTools below still applies.
      '--permission-mode',
      opts.permissionMode ?? 'bypassPermissions'
    ]
    // Pin the model when the user picked one; otherwise Claude's default applies.
    if (opts.model) args.push('--model', opts.model)
    if (resume) args.unshift('--resume', resume)
    if (mcpConfig) args.push('--mcp-config', mcpConfig)
    const appended = [
      TODO_PROMPT,
      SCHEDULING_PROMPT,
      CHOICES_PROMPT,
      FILE_OPEN_PROMPT,
      opts.browserProject ? BROWSER_SYSTEM_PROMPT : ''
    ]
      .filter(Boolean)
      .join(' ')
    args.push('--append-system-prompt', appended)
    // Hard stops: cloud/loop schedulers can't reach SuperAgent's browser (scheduling
    // must use create_routine). The Task* tools are Claude's task-tracking surface
    // that the Tasks panel now reads, so they're allowed. Unknown names are no-ops.
    args.push(
      '--disallowedTools',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup'
    )

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

/**
 * Names a conversation the way its own agent would describe it, via a throwaway
 * one-shot `claude -p`. Deliberately separate from the chat's session so the
 * request never lands in the transcript. Tools are off — this is pure text in,
 * text out — and a failure is silent: the caller keeps its fallback title.
 */
function suggestTitle(cwd: string, excerpt: string): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(
      findClaude(),
      [
        '-p',
        '--output-format',
        'text',
        '--max-turns',
        '1',
        // Variadic, so it must come last — it would otherwise swallow whatever
        // follows as tool names. The prompt goes in on stdin for the same reason.
        '--disallowedTools',
        ...['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Task']
      ],
      { cwd: cwd || os.homedir(), env: process.env, shell: false }
    )
    proc.stdin.on('error', () => {})
    proc.stdin.end(
      'Summarize what this conversation is about as a title of at most 6 words. ' +
        'Reply with the title only — no quotes, no trailing punctuation.\n\n' +
        excerpt
    )
    let out = ''
    const done = (value: string | null): void => {
      clearTimeout(timer)
      try {
        proc.kill()
      } catch {
        // already gone
      }
      resolve(value)
    }
    // Never let naming outlive the user's interest in it.
    const timer = setTimeout(() => done(null), 20_000)
    proc.stdout.on('data', (c: Buffer) => {
      out += c.toString('utf8')
    })
    proc.on('error', () => done(null))
    proc.on('close', () => {
      const title = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop()
        ?.replace(/^["']|["']$/g, '')
      done(title && title.length <= 80 ? title : null)
    })
  })
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:suggestTitle', (_e, cwd: string, excerpt: string) =>
    suggestTitle(cwd, excerpt)
  )
  ipcMain.handle('agent:start', (e, opts: AgentStartOptions) => startAgent(e.sender, opts))
  ipcMain.on('agent:send', (_e, id: string, text: string, images?: AgentImage[]) =>
    sendToAgent(id, text, images ?? [])
  )
  ipcMain.on('agent:interrupt', (_e, id: string) => interruptAgent(id))
  ipcMain.on('agent:stop', (_e, id: string) => stopAgent(id))
}
