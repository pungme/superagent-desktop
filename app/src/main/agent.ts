import { ipcMain, WebContents } from 'electron'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import os from 'os'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getHookUrl } from './hooks'
import { getMcpUrl, writeWorkspaceMcpConfig } from './mcp'
import { DESKTOP_WORKSPACE_ID } from './store'
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
  /**
   * The window that drives this session, if any. A session the phone started
   * has none until a window opens its chat and adopts it (see agent:start).
   */
  owner: WebContents | null
  buffer: string
  killed?: boolean
  chatId?: string
  workspaceId?: string
  opts: AgentStartOptions
  /** The last `system/init` event, replayed to a window that adopts the session. */
  lastInit?: Record<string, unknown>
}

const sessions = new Map<string, AgentSession>()

/**
 * Everything a session says, for anyone in main who cares — the companion's
 * event log first of all. The renderer bridge below is just one subscriber.
 *
 *  - 'event'       { id, chatId, workspaceId, event }   raw stream-json object
 *  - 'stderr'      { id, chatId, workspaceId, text }
 *  - 'exit'        { id, chatId, workspaceId, code }
 *  - 'resume-lost' { id, chatId, workspaceId }
 *  - 'user'        { id, chatId, workspaceId, text, images, from, localId }
 *  - 'started'     { id, chatId, workspaceId }
 */
export const agentBus = new EventEmitter()
agentBus.setMaxListeners(50)

export interface AgentSessionInfo {
  id: string
  chatId?: string
  workspaceId?: string
  owned: boolean
}

export function findSessionByChat(chatId: string): AgentSessionInfo | undefined {
  for (const s of sessions.values()) {
    if (s.chatId === chatId)
      return { id: s.id, chatId: s.chatId, workspaceId: s.workspaceId, owned: !!s.owner }
  }
  return undefined
}

/** What a session was started with — to tell whether a requested change needs a restart. */
export function getSessionOpts(id: string): AgentStartOptions | undefined {
  return sessions.get(id)?.opts
}

export function listSessions(): AgentSessionInfo[] {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    chatId: s.chatId,
    workspaceId: s.workspaceId,
    owned: !!s.owner
  }))
}

/**
 * A window takes over a session that was running without one (started from
 * the phone). From here on it streams to that window like any other session,
 * and dies with it on reload — the renderer's own lifecycle rules apply.
 */
function adoptSession(session: AgentSession, owner: WebContents): void {
  session.owner = owner
  watchOwner(owner)
  const init = session.lastInit
  if (init) {
    // The renderer waits for init to enable its composer; it already happened.
    setTimeout(() => {
      if (!owner.isDestroyed()) owner.send(`agent:event:${session.id}`, init)
    }, 0)
  }
}

export interface AgentStartOptions {
  cwd?: string
  workspaceId?: string
  /** The conversation this session belongs to — stamped onto board cards. */
  chatId?: string
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
  permissionMode?: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'ask'
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

// The board outlives the conversation, so it is where work that isn't happening
// right now belongs — the todo list above is per-turn and disappears with it.
const BOARD_PROMPT =
  'This project keeps a list that persists across conversations: stages todo, ' +
  'doing, testing and done, kept with board_list, board_add, board_move and ' +
  'board_update. It is yours to maintain, not just to append to.\n' +
  'ADD work that outlives this turn — something the user asked for and you ' +
  'deferred, a follow-up your change made necessary, a bug you noticed while ' +
  'doing something else. Call board_list first so you do not duplicate one. Do ' +
  'not add an item for work you are finishing in this same turn, and do not use ' +
  'the list as a scratchpad for the steps of one task — your task-tracking tools ' +
  'already do that.\n' +
  'MOVE an item to doing when you start it and done when you finish, so the list ' +
  'records what happened rather than what was intended. Use testing for work that ' +
  'is written but unverified.\n' +
  'TIDY as you go, with board_update. A title should say what to do specifically ' +
  'enough that someone else could pick it up: rewrite "fix the header" into "Stop ' +
  'the header collapsing below 400px". Put a short specification in the body — ' +
  'what done means, where to start, which files — when the item is worth more ' +
  'than its title. Merge duplicates, and remove items that turned out to be ' +
  'unnecessary.\n' +
  'Two limits on tidying. Do not rewrite an item just to reword it — only when it ' +
  'is genuinely unclear or you learned something that makes it clearer. And when ' +
  'the user wrote the item themselves, sharpen it rather than replacing what they ' +
  'meant; if you would be changing the intent, ask instead.'

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
  'extra explanation in "hint". SuperAgent renders these as buttons and sends the user\'s ' +
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

// The simulator the user is watching lives INSIDE SuperAgent, in a pane beside
// this chat. Apple's Simulator app is a separate window they did not ask for.
const SIMULATOR_PROMPT =
  'SuperAgent shows a live iOS Simulator in a pane next to this chat, and the user is ' +
  'watching THAT. Use the sim_* tools for anything simulator-related: sim_list_devices, ' +
  'sim_boot, sim_install_and_launch and sim_open_url to set it up, then drive it like a ' +
  'device — sim_screen to SEE it (it returns the screen as an image; there is no DOM, so ' +
  'look at the picture and read coordinates off it), sim_tap and sim_swipe to touch it (in ' +
  "sim_screen's pixels), sim_type to type into a focused field, sim_press for the home/lock/" +
  'side buttons, and sim_wait_stable to let a load or animation settle before the next step. ' +
  'The loop is the same as the browser: sim_screen, act, sim_screen again to check. Two rules ' +
  'follow from the pane:\n' +
  "1. Do NOT run `open -a Simulator`, `xcrun simctl boot` followed by opening Apple's " +
  'Simulator app, or otherwise launch the Simulator application — it puts a second window ' +
  'on screen, usually showing a different device from the one in the pane, and the user ' +
  "ends up watching the wrong thing. Only do it if they explicitly ask for Apple's " +
  'Simulator app by name.\n' +
  '2. Build, install and launch onto the device the pane is showing — sim_list_devices ' +
  'marks it. If you run simctl directly, pass that UDID rather than the word `booted`, ' +
  'which picks an arbitrary device when several are running.'

// The desktop chat is not a project's agent: it is the computer's own, and the
// computer is the thing it is being asked about.
const DESKTOP_PROMPT =
  'You are the agent of this computer. Not a project — the desktop itself: a surface with ' +
  'windows on it (Chat, which is this conversation, Browser, Dashboard, Skills, Routines), ' +
  'files the user has dropped on it, and a tabbed web browser.\n' +
  'You can see it and you can drive it. computer_state tells you what is open, where each ' +
  'window is, which one is in front, what the browser is showing and which files are on the ' +
  'desktop — read it whenever the user says "this window", "the browser" or "that file", ' +
  'because it is what is in front of them. computer_open_app, computer_close_app and ' +
  'computer_arrange open, close and lay out windows; computer_desktop_file puts a file on the ' +
  'desktop or takes it off; computer_browser_open opens a page, after which the browser_* ' +
  'tools drive the tab that is showing.\n' +
  'Arrange the desktop when it would help rather than describing what the user should click: ' +
  'if they ask to compare two things, tile them; if they ask about their usage, open the ' +
  'Dashboard. Say what you did in a line — do not narrate every window move.\n' +
  'Files dropped on the desktop are linked into ./files/ inside your working directory, so ' +
  'read them with ordinary file tools; nothing needs attaching. Your working directory is ' +
  "scratch space of the app's, not a project — write throwaway files there freely, and when " +
  'the user should be able to get at something you made, put it on the desktop.'

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

/**
 * Sessions that died before anyone could hear about it.
 *
 * startAgent returns the id over IPC and the renderer subscribes to
 * agent:exit:<id> only once that round trip lands — but a spawn failure
 * (missing binary, a project folder that no longer exists) arrives on the very
 * next tick, before the subscription exists, so the event went nowhere and the
 * chat span forever saying "Working". Record it here and let the renderer ask.
 */
const deadSessions = new Map<string, { code: number; reason?: string }>()

/**
 * The one line worth showing a person out of a blob of CLI stderr. Claude's own
 * diagnostics ("Your organization has disabled Claude subscription access…",
 * "Invalid API key…") are plain sentences; everything around them is node
 * warnings, debug logging and stack frames. Strip ANSI, drop the noise, and take
 * the last human-looking line.
 */
export function meaningfulStderr(raw: string): string | undefined {
  const noise =
    /^\s*(at\s|node:|\(node:|Debugger|Warning:|\[dotenv|npm warn|npm notice|\{|\}|".*":)/i
  const lines = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.length <= 300 && !noise.test(l))
  return lines.length ? lines[lines.length - 1] : undefined
}

function markDead(id: string, code: number, reason?: string): void {
  deadSessions.set(id, { code, reason })
  // Long enough for the renderer to ask, short enough not to be a leak.
  setTimeout(() => deadSessions.delete(id), 60_000)
}

/**
 * Same race as deadSessions, for resume-lost: the resume proc can fail before
 * the renderer has subscribed to agent:resume-lost:<id>, dropping the event — so
 * the chat silently continues context-blind with no recap and no notice. Record
 * it so the renderer can ask, exactly like it already asks agent:died.
 */
const resumeLostSessions = new Set<string>()

function markResumeLost(id: string): void {
  resumeLostSessions.add(id)
  setTimeout(() => resumeLostSessions.delete(id), 60_000)
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

/**
 * The exact command line a chat session runs on.
 *
 * Pulled out as a pure function for two reasons. It is the only place the
 * agent's reach is decided — the permission mode and the tools it may never
 * call — so it is worth testing rather than reading. And it is the seam a
 * second agent backend would sit behind: everything above it is "start a
 * conversation", everything below is "how this particular CLI is invoked".
 */
export function buildAgentArgs(
  opts: AgentStartOptions,
  ctx: { resume?: string | null; mcpConfig?: string } = {}
): string[] {
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
    // "ask" is SuperAgent's name for Claude Code's default mode: every tool
    // that would prompt in a terminal asks the app via the PermissionRequest
    // hook instead, and the app asks the user (Mac or phone).
    opts.permissionMode === 'ask' ? 'default' : (opts.permissionMode ?? 'bypassPermissions')
  ]
  // Pin the model only when the user picked one. "Default" ('') means "whatever
  // your account uses" — passing no --model lets the CLI resolve the account
  // default (which is often the best model you have, e.g. Opus 5), so don't
  // second-guess it with a forced downgrade. To force off a rate-limited model
  // on a resumed session, pick a concrete model — that DOES send --model and
  // overrides.
  if (opts.model) args.push('--model', opts.model)
  // Ask mode: headless claude can't show a prompt, so it asks our MCP server,
  // which asks the user (Mac modal or phone). See mcp.ts permission_prompt.
  if (opts.permissionMode === 'ask')
    args.push('--permission-prompt-tool', 'mcp__cove-browser__permission_prompt')
  if (ctx.resume) args.unshift('--resume', ctx.resume)
  if (ctx.mcpConfig) args.push('--mcp-config', ctx.mcpConfig)
  const appended = [
    TODO_PROMPT,
    BOARD_PROMPT,
    SCHEDULING_PROMPT,
    CHOICES_PROMPT,
    FILE_OPEN_PROMPT,
    SIMULATOR_PROMPT,
    opts.browserProject ? BROWSER_SYSTEM_PROMPT : '',
    // The desktop chat has no project, no board and no repository — it has a
    // computer, and a different set of tools for driving it.
    opts.workspaceId === DESKTOP_WORKSPACE_ID ? DESKTOP_PROMPT : ''
  ]
    .filter(Boolean)
    .join(' ')
  args.push('--append-system-prompt', appended)
  // Hard stops: cloud/loop schedulers can't reach SuperAgent's browser (scheduling
  // must use create_routine). The Task* tools are Claude's task-tracking surface
  // that the Tasks panel now reads, so they're allowed. Unknown names are no-ops.
  // Variadic, so this must stay last — it would otherwise swallow whatever
  // follows as tool names.
  args.push('--disallowedTools', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup')
  return args
}

export function startAgent(owner: WebContents | null, opts: AgentStartOptions): string {
  if (owner) watchOwner(owner)
  const id = randomUUID()
  const meta = { id, chatId: opts.chatId, workspaceId: opts.workspaceId }
  // A project folder that has been moved or deleted fails as a spawn ENOENT
  // naming the *binary*, which reads as "Claude Code is broken" when it isn't.
  // Catch it here so the chat can say what actually happened.
  if (opts.cwd && !existsSync(opts.cwd)) {
    markDead(id, 1, 'missing-cwd')
    setTimeout(() => {
      agentBus.emit('exit', { ...meta, code: 1 })
      if (owner && !owner.isDestroyed()) owner.send(`agent:exit:${id}`, 1)
    }, 0)
    return id
  }
  const mcpConfig =
    opts.mcpConfigPath ||
    (opts.workspaceId ? writeWorkspaceMcpConfig(opts.workspaceId, opts.chatId) : undefined)

  // A valid resume emits a `system/init` event; a missing session makes claude
  // exit having only emitted SessionStart *hook* events (which fire before the
  // session is validated). So we track the init event specifically — not any
  // stdout — to tell a successful start from a failed resume, and only fall back
  // to a fresh session when a resume never reached init.
  let sawInit = false

  const spawnProc = (resume: string | null): void => {
    const args = buildAgentArgs(opts, { resume, mcpConfig })

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

    const session: AgentSession = {
      id,
      proc,
      owner,
      buffer: '',
      chatId: opts.chatId,
      workspaceId: opts.workspaceId,
      opts
    }
    sessions.set(id, session)
    agentBus.emit('started', meta)

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
          if (event?.type === 'system' && event?.subtype === 'init') {
            sawInit = true
            session.lastInit = event
          }
          agentBus.emit('event', { ...meta, event })
          const o = session.owner
          if (o && !o.isDestroyed()) o.send(`agent:event:${id}`, event)
        } catch {
          // partial or non-JSON line; ignore
        }
      }
    })

    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      agentBus.emit('stderr', { ...meta, text: chunk.toString('utf8') })
      const o = session.owner
      if (o && !o.isDestroyed()) o.send(`agent:stderr:${id}`, chunk.toString('utf8'))
    })

    // spawn failures (e.g. ENOENT when the binary can't be found) emit 'error',
    // not 'exit'; without this handler that's an unhandled error on the child.
    proc.on('error', (err) => {
      console.error('[agent] spawn error:', err.message)
      sessions.delete(id)
      if (session.killed) return
      if (resume && !sawInit) {
        notifyResumeLost(session.owner, meta)
        spawnProc(null)
        return
      }
      markDead(id, 1)
      agentBus.emit('exit', { ...meta, code: 1 })
      const o = session.owner
      if (o && !o.isDestroyed()) o.send(`agent:exit:${id}`, 1)
    })

    proc.on('exit', (code) => {
      sessions.delete(id)
      if (code && code !== 0 && stderr) console.error('[agent] exited', code, stderr.slice(0, 300))
      if (session.killed) return
      if (resume && !sawInit) {
        // The resume target was unavailable (claude exited before emitting
        // anything) — retry once with a fresh session.
        notifyResumeLost(session.owner, meta)
        spawnProc(null)
        return
      }
      markDead(id, code ?? 0, meaningfulStderr(stderr))
      agentBus.emit('exit', { ...meta, code: code ?? 0 })
      const o = session.owner
      if (o && !o.isDestroyed()) o.send(`agent:exit:${id}`, code ?? 0)
    })
  }

  spawnProc(opts.resumeSessionId ?? null)
  return id
}

export interface AgentImage {
  mediaType: string
  data: string // base64
}

/**
 * Put a pasted image on disk and hand back the path.
 *
 * The image also travels inline, which is the fast path and normally all that
 * is needed. But an inline image is attached to one message: if that message
 * arrives mid-turn, or the session is later resumed, the agent can end up
 * unable to see the picture the user is plainly talking about — it went
 * looking for "wherever the app saved it" and there was nothing there. Now
 * there is, and the path travels as text, which nothing drops.
 */
function saveImageForAgent(im: AgentImage): string | null {
  try {
    const dir = join(os.tmpdir(), 'superagent-pasted')
    mkdirSync(dir, { recursive: true })
    const ext = (im.mediaType.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '')
    const file = join(dir, `paste-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`)
    writeFileSync(file, Buffer.from(im.data, 'base64'))
    return file
  } catch {
    return null
  }
}

/**
 * Say when a conversation could not be resumed.
 *
 * Falling back to a fresh session is the right move — better than a dead chat —
 * but it happened silently, so the window went on showing a conversation the
 * model behind it no longer had any of. The one case where "does it still
 * remember?" has a surprising answer, and nothing said so.
 */
function notifyResumeLost(
  owner: WebContents | null,
  meta: { id: string; chatId?: string; workspaceId?: string }
): void {
  markResumeLost(meta.id)
  agentBus.emit('resume-lost', meta)
  if (owner && !owner.isDestroyed()) owner.send(`agent:resume-lost:${meta.id}`)
}

export function sendToAgent(
  id: string,
  text: string,
  images: AgentImage[] = [],
  origin: { from: 'desktop' | 'ios'; localId?: string } = { from: 'desktop' }
): boolean {
  const session = sessions.get(id)
  if (!session || !session.proc.stdin.writable) return false
  // Announce before writing, so the log has the prompt ahead of any reply.
  agentBus.emit('user', {
    id,
    chatId: session.chatId,
    workspaceId: session.workspaceId,
    text,
    images: images.map((im) => ({ mediaType: im.mediaType, size: im.data.length })),
    from: origin.from,
    localId: origin.localId
  })
  // A prompt from the phone also has to reach the window showing this chat.
  if (origin.from !== 'desktop') {
    const o = session.owner
    if (o && !o.isDestroyed()) o.send(`agent:user:${id}`, { text, from: origin.from })
  }
  if (images.length > 0) {
    const paths = images.map((im) => saveImageForAgent(im)).filter(Boolean)
    if (paths.length > 0) {
      const many = paths.length > 1
      // The inline image below is the fast path, but it does NOT survive a
      // mid-turn message or a resumed session (see saveImageForAgent) — which is
      // when the model would otherwise say "the image didn't come through". So
      // the saved copy is authoritative: instruct a Read, not a maybe-read.
      text =
        `${text}${text ? '\n\n' : ''}[The user attached ${many ? 'images' : 'an image'}, ` +
        `saved to disk. If you cannot see ${many ? 'them' : 'it'} inline, Read ${many ? 'these paths' : 'this path'} ` +
        `now to see what the user is referring to — do not say the image didn't come through:\n${paths.join('\n')}]`
    }
  }
  const content = [
    ...images.map((im) => ({
      type: 'image',
      source: { type: 'base64', media_type: im.mediaType, data: im.data }
    })),
    ...(text ? [{ type: 'text', text }] : [])
  ]
  const message = { type: 'user', message: { role: 'user', content } }
  session.proc.stdin.write(JSON.stringify(message) + '\n')
  return true
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

/**
 * Interrupt that works even mid-tool-call.
 *
 * The stdin control_request above is the polite route, but the CLI only reads
 * stdin between steps — inside a long Bash call (a 15-minute deploy) nothing is
 * read at all, which is why a mid-turn message could sit unseen for a quarter of
 * an hour. A signal doesn't need the CLI to be listening. Escalates: control
 * request → SIGINT → kill, and reports whether the process ended so the caller
 * knows it has to resume the session.
 */
export async function hardInterruptAgent(id: string): Promise<boolean> {
  const session = sessions.get(id)
  if (!session) return true
  interruptAgent(id)
  const gone = async (ms: number): Promise<boolean> => {
    const until = Date.now() + ms
    while (Date.now() < until) {
      if (session.proc.exitCode !== null || session.proc.signalCode !== null) return true
      await new Promise((r) => setTimeout(r, 60))
    }
    return false
  }
  if (await gone(700)) return true
  session.killed = true // a deliberate interrupt is not a crash
  session.proc.kill('SIGINT')
  if (await gone(1200)) {
    sessions.delete(id)
    return true
  }
  session.proc.kill('SIGKILL')
  sessions.delete(id)
  return true
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
export function suggestTitle(cwd: string, excerpt: string): Promise<string | null> {
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
    proc.on('close', (code) => {
      // A non-zero exit means the CLI printed diagnostics, not a title.
      if (code !== 0) return done(null)
      const title = out
        .trim()
        .split('\n')
        .filter(Boolean)
        .pop()
        ?.replace(/^["']|["']$/g, '')
      // The CLI reports its own failures on stdout ("Error: Reached max turns"),
      // and one of those once became a chat's actual title. Anything that reads
      // as an error keeps the placeholder instead.
      if (title && /^(error|⚠|warning)\b|max turns|rate limit/i.test(title)) return done(null)
      done(title && title.length <= 80 ? title : null)
    })
  })
}

export function registerAgentIpc(): void {
  ipcMain.handle('agent:suggestTitle', (_e, cwd: string, excerpt: string) =>
    suggestTitle(cwd, excerpt)
  )
  ipcMain.handle('agent:start', (e, opts: AgentStartOptions) => {
    // The phone may already be running this chat's agent. Adopt it rather than
    // spawning a second claude on the same conversation.
    if (opts.chatId) {
      for (const s of sessions.values()) {
        if (s.chatId === opts.chatId && !s.owner) {
          adoptSession(s, e.sender)
          return s.id
        }
      }
    }
    return startAgent(e.sender, opts)
  })
  // Asked once, right after the renderer subscribes: did this session already
  // die in the gap? Returns the exit code, or null if it's alive.
  ipcMain.handle('agent:died', (_e, id: string) => deadSessions.get(id) ?? null)
  // Same catch-up question for a resume that failed before the renderer could
  // subscribe: consume it (delete) so a later re-query doesn't re-fire it.
  ipcMain.handle('agent:resume-lost-check', (_e, id: string) => {
    const lost = resumeLostSessions.has(id)
    resumeLostSessions.delete(id)
    return lost
  })
  ipcMain.on('agent:send', (_e, id: string, text: string, images?: AgentImage[]) =>
    sendToAgent(id, text, images ?? [], { from: 'desktop' })
  )
  ipcMain.on('agent:interrupt', (_e, id: string) => interruptAgent(id))
  ipcMain.on('agent:stop', (_e, id: string) => stopAgent(id))
  ipcMain.handle('agent:hard-interrupt', (_e, id: string) => hardInterruptAgent(id))
}
