import { useEffect, useRef, useState, useCallback, useMemo, memo } from 'react'
import { useStore, useOverlayLock, TodoItem, PermissionMode } from '../state'
import { TasksPanel } from './TasksPanel'
import { Markdown } from './Markdown'
import { Choices } from './Choices'
import { splitAssistant } from './assistantSegments'
import { useDictation } from '../lib/dictation'

interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  images?: string[] // data URLs, for user messages
  replyTo?: { role: 'user' | 'assistant'; text: string } // WhatsApp-style quoted message
  system?: boolean // app-generated notice (e.g. a failed/empty turn), not from Claude
  at?: number // when it arrived, for the hover timestamp (absent on older saved chats)
}

interface PendingImage {
  mediaType: string
  data: string // base64 (no data-URL prefix)
  url: string // data URL for preview
}

interface ToolCall {
  id: string
  name: string
  detail: string
}

interface DiffHunk {
  removed: string[]
  added: string[]
}

interface FileDiff {
  id: string
  file: string
  hunks: DiffHunk[]
}

type Item =
  | { kind: 'msg'; msg: ChatMessage }
  | { kind: 'tool'; tool: ToolCall }
  | { kind: 'diff'; diff: FileDiff }
  | { kind: 'thinking'; id: string; text: string }

/**
 * A dev server, as one of the pills that sit beside Model and Mode.
 *
 * It used to be a band floating over the transcript, which covered the last
 * messages and shouted about something you mostly want to glance at. The row
 * under the composer is already where this chat says what it is running on;
 * something the project is running belongs in the same row.
 */
function DevServerPill({
  workspaceId,
  open,
  onToggle
}: {
  workspaceId: string
  open: boolean
  onToggle: () => void
}): React.JSX.Element | null {
  const ports = useStore((s) => s.ports[workspaceId])
  // browserOpen is keyed per chat now, so resolve the project's active chat to
  // tell whether the preview is already showing (and the pill can hide).
  const paneOpen = useStore(
    (s) => s.browserOpen[s.activeChatId[workspaceId] ?? workspaceId] === true
  )
  const openPreview = useStore((s) => s.openPreview)
  const removePort = useStore((s) => s.removePort)
  const [dismissed, setDismissed] = useState(false)
  const port = ports?.[0]
  if (!port || paneOpen || dismissed) return null
  return (
    <div className="easy-control">
      <button
        className={`easy-control-btn ${open ? 'open' : ''}`}
        onClick={onToggle}
        title={`Dev server on localhost:${port}`}
      >
        <span className="easy-run-dot live" />
        <span className="easy-control-key">Server</span>
        <span className="easy-control-val">:{port}</span>
      </button>
      {open && (
        <div className="easy-control-menu">
          <button
            className="easy-control-item"
            onClick={() => {
              onToggle()
              openPreview(workspaceId, port)
            }}
          >
            <span className="easy-control-item-label">Open preview</span>
            <span className="easy-control-item-hint">Show localhost:{port} in the pane</span>
          </button>
          <button
            className="easy-control-item easy-run-stop"
            onClick={() => {
              onToggle()
              void window.cove.killPort(port)
              removePort(workspaceId, port)
            }}
          >
            <span className="easy-control-item-label">⏹ Stop the server</span>
            <span className="easy-control-item-hint">Kill the process on :{port}</span>
          </button>
          <button
            className="easy-control-item"
            onClick={() => {
              onToggle()
              setDismissed(true)
            }}
          >
            {/* The pill is scraped from the agent's output, so it can name a
                server that isn't ours to kill — something external, shared, or a
                stale detection. Dismiss drops the chip without touching it. */}
            <span className="easy-control-item-label">Dismiss</span>
            <span className="easy-control-item-hint">
              Not my server / not interested — keep it running, drop the pill
            </span>
          </button>
        </div>
      )}
    </div>
  )
}

interface EasyChatProps {
  cwd: string
  workspaceId: string
  /** Which of the project's conversations this is. Owns the transcript + session. */
  chatId: string
  initialSessionId?: string | null
  browserProject?: boolean
  /**
   * Suppress the floating "New chat" pill. The desktop Chat app keeps a list of
   * conversations with its own button, and two of them a few inches apart doing
   * the same thing is one too many.
   */
  hideNewChat?: boolean
  /** Whether this chat's workspace is the one on screen. Background chats stay
      mounted (so switching back is instant) but get their claude process reaped
      once they've been idle a while — see IDLE_REAP_MS. */
  visible?: boolean
  /** Where the chat sits relative to the pane, and how to flip it. */
}

// Drop lines shared by the start/end of both sides so only the real change shows.
function trimCommon(removed: string[], added: string[]): DiffHunk {
  let start = 0
  while (start < removed.length && start < added.length && removed[start] === added[start]) start++
  let endR = removed.length
  let endA = added.length
  while (endR > start && endA > start && removed[endR - 1] === added[endA - 1]) {
    endR--
    endA--
  }
  return { removed: removed.slice(start, endR), added: added.slice(start, endA) }
}

// Build a diff card from an Edit/Write/MultiEdit tool's input (returns null for other tools).
function toolDiff(name: string, id: string, input: unknown): FileDiff | null {
  if (!input || typeof input !== 'object') return null
  const o = input as Record<string, unknown>
  const file = typeof o.file_path === 'string' ? (o.file_path.split('/').pop() ?? '') : ''
  // Drop one trailing newline so a spurious empty "+"/"-" line isn't shown.
  const lines = (s: unknown): string[] =>
    typeof s === 'string' && s ? s.replace(/\n$/, '').split('\n') : []
  if (name === 'Edit' && (o.old_string || o.new_string)) {
    return { id, file, hunks: [trimCommon(lines(o.old_string), lines(o.new_string))] }
  }
  if (name === 'Write' && o.content) {
    return { id, file, hunks: [{ removed: [], added: lines(o.content) }] }
  }
  if (name === 'MultiEdit' && Array.isArray(o.edits)) {
    const hunks = (o.edits as Record<string, unknown>[]).map((e) =>
      trimCommon(lines(e.old_string), lines(e.new_string))
    )
    return { id, file, hunks }
  }
  return null
}

/**
 * The "Working Ns" counter, isolated so its 1s tick re-renders only this label —
 * not the whole chat. (Ticking `elapsed` on the parent re-rendered the entire
 * transcript twice a second, pinning the renderer on long turns.)
 */
function WorkingTimer(): React.JSX.Element | null {
  const [secs, setSecs] = useState(0)
  useEffect(() => {
    const start = Date.now()
    const t = setInterval(() => setSecs(Math.floor((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(t)
  }, [])
  if (secs < 1) return null
  return <span className="easy-elapsed">Working {secs}s</span>
}

/** Monochrome line icon, matching the sidebar's — currentColor, no emoji. */
function MicIcon(): React.JSX.Element {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="6" y="1.8" width="4" height="7.4" rx="2" />
      <path d="M3.6 7.2v.8a4.4 4.4 0 0 0 8.8 0v-.8" />
      <path d="M8 12.4v1.8" />
    </svg>
  )
}

// Short verb + icon for the noisy internal tool names.
function toolLabel(name: string): { icon: string; verb: string } {
  if (name.startsWith('mcp__cove-browser__browser_')) {
    const action = name.replace('mcp__cove-browser__browser_', '').replace(/_/g, ' ')
    return { icon: '🌐', verb: action }
  }
  if (name.startsWith('mcp__cove-browser__sim_')) {
    const action = name.replace('mcp__cove-browser__sim_', '').replace(/_/g, ' ')
    return { icon: '📱', verb: action }
  }
  const map: Record<string, { icon: string; verb: string }> = {
    // "Terminal", not "Running": this label shows in a finished turn's collapsed
    // summary too ("2 steps · …"), where a gerund read as "still running now".
    Bash: { icon: '⌘', verb: 'Terminal' },
    Read: { icon: '📄', verb: 'Reading' },
    Edit: { icon: '✏️', verb: 'Editing' },
    Write: { icon: '✏️', verb: 'Writing' },
    MultiEdit: { icon: '✏️', verb: 'Editing' },
    Glob: { icon: '🔎', verb: 'Finding files' },
    Grep: { icon: '🔎', verb: 'Searching' },
    WebFetch: { icon: '🌐', verb: 'Fetching' },
    WebSearch: { icon: '🔎', verb: 'Searching the web' },
    TodoWrite: { icon: '✓', verb: 'Planning' },
    Task: { icon: '🤖', verb: 'Sub-agent' },
    ToolSearch: { icon: '🧰', verb: 'Finding tools' }
  }
  // Any other MCP tool: strip the mcp__server__ prefix so it reads as words, not
  // a raw internal id (mcp__cove-browser__sim_list_devices → "list devices").
  const mcp = name.match(/^mcp__[a-z0-9-]+__(.+)$/i)
  if (mcp) return { icon: '🔧', verb: mcp[1].replace(/_/g, ' ') }
  return map[name] ?? { icon: '🔧', verb: name }
}

// Pull the most meaningful field out of a tool's input for a one-line detail.
// A ToolSearch "select:a,b,c" query → a short, human list ("browser navigate, …").
function friendlyToolNames(select: string): string {
  const names = select
    .replace(/^select:/, '')
    .split(',')
    .map((n) =>
      n
        .trim()
        .replace(/^mcp__[a-z0-9-]+__/i, '')
        .replace(/_/g, ' ')
    )
    .filter(Boolean)
  const shown = names.slice(0, 3).join(', ')
  return names.length > 3 ? `${shown} +${names.length - 3}` : shown
}

/** A command the agent backgrounded, tracked until its shell reports it's done. */
interface BackgroundTask {
  /** The tool_use id of the Bash call, used to pick the shell id out of its result. */
  toolUseId: string
  /** Claude's shell handle, once its result tells us. */
  shellId?: string
  command: string
  /**
   * The Bash tool's own `description` — the short "what this does" line the agent
   * writes, and exactly what the terminal shows. Preferred over parsing the
   * command, so the pill reads as "Research US indie lane", not "node".
   */
  description?: string
  startedAt: number
  /** Latest output the agent has polled back, so the strip can show what's happening. */
  output?: string
  outputAt?: number
  /** File the shell streams into; tailed directly for live output. */
  outputPath?: string
  /**
   * Backgrounded with a trailing `&` in a normal Bash call, not the
   * run_in_background flag. We have no shell handle for it, so it can't be
   * polled — it stays until the user dismisses it, or until `expiresAt` if we
   * could work out when it finishes (a `sleep N` timer has a known duration).
   */
  manual?: boolean
  /** When a known-duration job (e.g. `sleep N`) is done, so it auto-clears. */
  expiresAt?: number
}

/** Seconds a `sleep <n>` waits, if the command is (essentially) just that. */
function sleepDurationSec(command: string): number | null {
  const m = command
    .replace(/&\s*(disown)?\s*;?\s*$/, '')
    .trim()
    .match(/^sleep\s+(\d+)\b/)
  return m ? Number(m[1]) : null
}

/** A shell command backgrounded with a trailing `&` (but not `&&`). */
function isBackgrounded(command: string): boolean {
  const c = command.trim()
  // Ends with a single & (optionally `& disown` / `&;`), and it isn't `&&`.
  return /(^|[^&])&(\s*;?\s*disown)?\s*;?\s*$/.test(c)
}

// The Bash tool answers a backgrounded run with the shell's handle; BashOutput
// reports where that shell got to. Both are plain text, so read them loosely — a
// missed match leaves the pill up a little longer, which beats retiring a task
// that's still going.
const BG_SHELL_ID_RE = /(?:ID|bash_id|shell)[:\s]+([A-Za-z0-9_-]+)/i
// "Output is being written to: /…/tasks/<id>.output" — reading that file is how
// the strip shows live output without waiting for the agent to poll the shell.
const BG_OUTFILE_RE = /written to:\s*(\S+\.output)/i
// A backgrounded shell reports its end several ways: an XML/label status, a
// bare "[killed]"/"[completed]" marker (what BashOutput writes when a shell is
// killed — this one used to slip through, leaving a dead job pinned to the strip
// as "running" forever), or a plain exit-code line.
const BG_DONE_RE =
  /<status>\s*(completed|failed|killed)\s*<\/status>|status:\s*(completed|failed|killed)\b|\[(completed|failed|killed|done)\]|exited? with code\s*-?\d+/i

/**
 * When a message arrived. Transcripts saved before this field existed have no
 * `at`, but their ids were minted as `u-<epoch>` / `a-<epoch>` / `sys-<epoch>`,
 * so the time is recoverable — and null when it genuinely isn't, so the stamp is
 * simply omitted rather than rendering "Invalid Date" over old conversations.
 */
/**
 * A short, meaningful name for a backgrounded command. The real command is
 * often buried behind env setup — `export PATH=…; SP_TOKEN=$(…); node deadline.mjs &`
 * — so skip leading assignments, `export`, `nohup`, `sudo` and the like, and
 * name it by the actual program (and its script, if it has one).
 */
function bgLabel(command: string): string {
  const bare = command.replace(/&\s*(disown)?\s*;?\s*$/, '').trim()
  // The agent backgrounds `sleep N; echo done` as a wait/poll timer while other
  // work runs. Naming it "sleep" reads like the app dozed off (and taking the
  // last `;` segment would call it "echo"); say what it actually is.
  const wait = bare.match(/^sleep\s+(\d+)\b/)
  if (wait) {
    const s = Number(wait[1])
    return s >= 60 ? `wait ${Math.round(s / 60)}m` : `wait ${s}s`
  }
  // Last segment of a ; / && chain is usually the real work.
  const seg = bare
    .split(/;|&&/)
    .map((s) => s.trim())
    .filter(Boolean)
    .pop()
  const tokens = (seg || command).split(/\s+/).filter(Boolean)
  const skip = /^(export|nohup|sudo|env|time|VAR=|[A-Z_][A-Z0-9_]*=)/
  let i = 0
  while (i < tokens.length && (skip.test(tokens[i]) || tokens[i].includes('='))) i++
  const prog = (tokens[i] || tokens[0] || 'job').split('/').pop() || 'job'
  // For an interpreter, the script name is what the user recognises.
  if (/^(node|python3?|ruby|bash|sh|deno|bun|npx)$/.test(prog)) {
    const arg = tokens.slice(i + 1).find((t) => !t.startsWith('-'))
    if (arg) return arg.split('/').pop() || prog
  }
  return prog
}

// Tools that change files on disk — after one of these a code preview may
// genuinely look different, so the idle-reload should fire. (Bash is excluded
// on purpose: it's mostly read-only inspection, and reloading on every command
// is the noise we're trying to remove.)
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'edit_file'])

function msgAt(msg: { id: string; at?: number }): number | null {
  if (typeof msg.at === 'number' && Number.isFinite(msg.at)) return msg.at
  const legacy = /^(?:u|a|sys)-(\d{10,})/.exec(msg.id)
  return legacy ? Number(legacy[1]) : null
}

/**
 * The one human-readable line out of a chunk of CLI stderr — Claude's own
 * diagnostic ("Your organization has disabled Claude subscription access…"),
 * not the node warnings and stack frames around it. Kept in sync with the
 * main-process meaningfulStderr(); used to show the real reason a turn failed.
 */
function meaningfulStderr(raw: string): string | null {
  const noise =
    /^\s*(at\s|node:|\(node:|Debugger|Warning:|\[dotenv|npm warn|npm notice|\{|\}|".*":)/i
  const lines = raw
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && l.length <= 300 && !noise.test(l))
  return lines.length ? lines[lines.length - 1] : null
}

/** Clock time for a message's hover stamp; the title carries the full date. */
function msgTime(ms: number): string {
  const d = new Date(ms)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)
  const daysAgo = Math.floor((midnight.getTime() - d.getTime()) / 86_400_000) + 1
  // A bare clock is ambiguous the moment a conversation spans days.
  if (d.getTime() >= midnight.getTime()) return `Today ${time}`
  if (daysAgo === 1) return `Yesterday ${time}`
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const date = d.toLocaleDateString(
    [],
    sameYear
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' }
  )
  return `${date} ${time}`
}

function toolDetail(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const pick = o.query ?? o.url ?? o.pattern ?? o.command ?? o.prompt ?? o.description ?? o.text
  if (typeof pick === 'string') {
    if (pick.startsWith('select:')) return friendlyToolNames(pick)
    return pick.replace(/\s+/g, ' ').trim().slice(0, 70)
  }
  if (typeof o.file_path === 'string') return o.file_path.split('/').pop() ?? ''
  return ''
}

// Any run of 2+ collapses to one line. Runs only group *consecutive* tool calls, so
// interleaved text/thinking splits them into short fragments — a higher threshold
// left most of those expanded, which is the noise this is meant to hide.
const TOOL_COLLAPSE_MIN = 2

// Task maps per chat — see the `tasks` ref. Module-level so a remounted chat
// picks its map back up.
const taskStores = new Map<string, Map<string, TodoItem>>()

// How long a backgrounded chat may sit idle before its claude process is reaped.
// Long enough that flipping between two projects never restarts anything, short
// enough that a day of clicking around doesn't leave a dozen idle agents resident.
const IDLE_REAP_MS = 5 * 60 * 1000

// One-liners for Claude's built-in slash commands, so the "/" menu explains each
// like the terminal does. The session's init event only reports command *names*;
// the user's own skills carry their own descriptions (from SKILL.md), so these
// only fill in the built-ins. /loop's blurb tells the Superagent truth: it becomes
// a Routine here (the cloud/session schedulers can't reach this app's browser).
const BUILTIN_COMMAND_DESCRIPTIONS: Record<string, string> = {
  clear: 'Reset the conversation context, keeping project memory',
  compact: 'Summarize the conversation to free up the context window',
  'code-review': 'Review the current diff for bugs and improvements',
  'security-review': 'Check the current diff for security vulnerabilities',
  review: 'Review the current diff for bugs and improvements',
  simplify: 'Clean up changed code — reuse, simplify, efficiency',
  batch: 'Orchestrate large-scale changes across the codebase',
  loop: 'Repeat a prompt in this chat until you stop — /loop [5m] <prompt>',
  goal: 'Set a goal condition for the session to work toward',
  btw: 'Ask a quick side question without adding it to history',
  model: 'Switch the AI model for this and future sessions',
  effort: 'Set reasoning effort (low / medium / high / xhigh / max)',
  fast: 'Toggle fast mode for quicker responses',
  advisor: 'Enable a second model for guidance',
  cd: 'Move the session to a new working directory',
  'add-dir': 'Add directory access without moving the session',
  branch: 'Branch the conversation to try a different direction',
  fork: 'Copy the conversation into a new background session',
  init: 'Scan the project and write a CLAUDE.md guide',
  mcp: 'Manage MCP server connections',
  config: 'Adjust settings (theme, model, output style)',
  permissions: 'Set approval rules and access controls',
  export: 'Export the conversation as plain text',
  copy: 'Copy the last response to the clipboard',
  doctor: 'Run a setup checkup to diagnose issues',
  debug: 'Enable debug logging and troubleshoot issues',
  rewind: 'Roll code and conversation back to a checkpoint',
  'design-sync': 'Upload your React design system to Claude Design',
  help: 'Show all available commands'
}

/** Safety cap so a loop can't run away forever. */
const LOOP_CAP = 100
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

/**
 * Parse a `/loop` command like the terminal's: `/loop <prompt>` runs the prompt
 * again each time the turn finishes; `/loop 5m <prompt>` (or `<prompt> every 5
 * minutes`) runs it on that interval. Returns null if it isn't a /loop command;
 * an empty prompt tells the caller to show usage.
 */
function parseLoopCmd(raw: string): { intervalMs: number | null; prompt: string } | null {
  const m = /^\/loop\b\s*(.*)$/is.exec(raw.trim())
  if (!m) return null
  const body = m[1].trim()
  if (!body) return { intervalMs: null, prompt: '' }
  const lead = /^(\d+)\s*([smhd])\s+(.+)$/is.exec(body)
  if (lead)
    return { intervalMs: Number(lead[1]) * UNIT_MS[lead[2].toLowerCase()], prompt: lead[3].trim() }
  const trail =
    /^(.+?)\s+every\s+(\d+)\s*(s|m|h|d|sec|secs|second|seconds|min|mins|minute|minutes|hour|hours|day|days)$/is.exec(
      body
    )
  if (trail) {
    const u = trail[3].toLowerCase()[0] as 's' | 'm' | 'h' | 'd'
    return { intervalMs: Number(trail[2]) * UNIT_MS[u], prompt: trail[1].trim() }
  }
  return { intervalMs: null, prompt: body }
}

function humanInterval(ms: number): string {
  if (ms % UNIT_MS.d === 0) return `${ms / UNIT_MS.d}d`
  if (ms % UNIT_MS.h === 0) return `${ms / UNIT_MS.h}h`
  if (ms % UNIT_MS.m === 0) return `${ms / UNIT_MS.m}m`
  return `${Math.round(ms / 1000)}s`
}

// Pull dev-server ports out of a tool's output — "Local: http://localhost:3000",
// "listening on port 5173", "Serving HTTP on 0.0.0.0 port 8000", etc. Used to offer
// a one-click "Open preview" when the agent starts a server. Skips :80/:443.
function extractPorts(text: string): number[] {
  const found = new Set<number>()
  const re =
    /(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5}))|(?:\blocalhost:(\d{2,5}))|(?:\bport\s+(\d{2,5}))/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const p = Number(m[1] || m[2] || m[3])
    if (p >= 1024 && p <= 65535) found.add(p)
  }
  return [...found]
}

// Model choices for the composer picker. '' = Claude's own default (whatever the
// CLI is configured to use); the rest are passed as --model at spawn.
// Order + wording follow Claude Code's own /model picker so the two agree.
// The 1M variants for Opus/Sonnet are deliberate: plain `opus` runs the 200K
// model, so picking it here quietly gave a fifth of the window the default
// already had (the CLI resolves the default to claude-opus-5[1m]).
const MODEL_OPTIONS: { value: string; label: string; hint: string }[] = [
  { value: '', label: 'Default', hint: 'Recommended · best for everyday, complex tasks' },
  { value: 'opus[1m]', label: 'Opus', hint: 'Opus 5 · 1M context · everyday, complex tasks' },
  {
    value: 'fable',
    label: 'Fable',
    hint: 'Fable 5 · most capable, for the hardest, longest tasks'
  },
  { value: 'sonnet[1m]', label: 'Sonnet', hint: 'Sonnet 5 · efficient for routine tasks' },
  { value: 'haiku', label: 'Haiku', hint: 'Haiku 4.5 · fastest for quick answers' }
]

/**
 * "claude-fable-5-20260115" → "Fable". The picker's Default entry shows this so
 * you can see what your account default actually resolves to.
 */
function shortModel(id: string): string {
  const known = ['opus', 'sonnet', 'haiku', 'fable', 'mythos']
  const hit = known.find((k) => id.toLowerCase().includes(k))
  if (!hit) return 'Default'
  const version = /-(\d+(?:\.\d+)?)/.exec(id.toLowerCase().split(hit)[1] ?? '')?.[1]
  return hit[0].toUpperCase() + hit.slice(1) + (version ? ` ${version}` : '')
}

// Agent modes (permission-mode). Plan = read-only planning, no changes made.
const MODE_OPTIONS: {
  value: 'bypassPermissions' | 'acceptEdits' | 'plan' | 'ask'
  label: string
  hint: string
}[] = [
  {
    value: 'bypassPermissions',
    label: 'Full',
    hint: 'Runs commands and edits, like your terminal'
  },
  {
    value: 'ask',
    label: 'Ask',
    hint: 'Asks before commands and edits — approve here or on your phone'
  },
  {
    value: 'acceptEdits',
    label: 'Edits',
    hint: 'Applies file edits; some commands may be refused'
  },
  { value: 'plan', label: 'Plan', hint: 'Read-only — plans without changing anything' }
]

// "Running ×9 · Reading ×6" — distinct verbs in first-seen order, so the collapsed
// row still says what the agent actually did.
function summarizeTools(tools: ToolCall[]): string {
  const counts = new Map<string, number>()
  for (const t of tools) {
    const { verb } = toolLabel(t.name)
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }
  const parts = [...counts].map(([verb, n]) => (n > 1 ? `${verb} ×${n}` : verb))
  return parts.slice(0, 3).join(' · ') + (parts.length > 3 ? ' · …' : '')
}

// One thing the agent did — a tool call or a file edit. A run of these (only
// broken by a real message) collapses into a single ActivityStrip.
type Activity = { kind: 'tool'; tool: ToolCall } | { kind: 'diff'; diff: FileDiff }

function toolChip(t: ToolCall, cls: string, key: string): React.JSX.Element {
  const { icon, verb } = toolLabel(t.name)
  return (
    <span key={key} className={cls} title={t.detail}>
      <span className="easy-tool-icon">{icon}</span>
      <span className="easy-tool-verb">{verb}</span>
      {t.detail && <span className="easy-tool-detail">{t.detail}</span>}
    </span>
  )
}

// Memoized like MessageRow: settled strips skip re-render during streaming (the
// entries array identity is stable thanks to the rows useMemo, except for the
// strip currently receiving new tool entries).
const ActivityStrip = memo(function ActivityStrip({
  entries
}: {
  entries: Activity[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  // A lone entry reads fine on its own — a chip for a tool, a card for an edit.
  if (entries.length < TOOL_COLLAPSE_MIN) {
    const e = entries[0]
    if (!e) return <></>
    return e.kind === 'diff' ? (
      <DiffCard diff={e.diff} />
    ) : (
      <div className="easy-tools">{toolChip(e.tool, 'easy-tool', e.tool.id)}</div>
    )
  }

  const tools = entries.flatMap((e) => (e.kind === 'tool' ? [e.tool] : []))
  const edits = entries.filter((e) => e.kind === 'diff').length
  const parts: string[] = []
  if (tools.length) parts.push(`${tools.length} step${tools.length > 1 ? 's' : ''}`)
  if (edits) parts.push(`${edits} edit${edits > 1 ? 's' : ''}`)

  return (
    <div className="easy-toolgroup">
      <button
        className="easy-tools-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={open ? 'Hide steps' : 'Show steps'}
      >
        <span className={'easy-tools-caret' + (open ? ' is-open' : '')}>›</span>
        <span className="easy-tools-count">{parts.join(' · ')}</span>
        {!open && tools.length > 0 && (
          <span className="easy-tools-summary">{summarizeTools(tools)}</span>
        )}
      </button>
      {open && (
        <div className="easy-toollist">
          {entries.map((e, i) =>
            e.kind === 'diff' ? (
              <DiffCard key={'d' + i} diff={e.diff} />
            ) : (
              toolChip(e.tool, 'easy-toolrow', e.tool.id + i)
            )
          )}
        </div>
      )}
    </div>
  )
})

// A file edit — collapsed to one line by default so the chat isn't flooded with
// diffs; click to see the actual change.
function DiffCard({ diff }: { diff: FileDiff }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const added = diff.hunks.reduce((n, h) => n + h.added.length, 0)
  const removed = diff.hunks.reduce((n, h) => n + h.removed.length, 0)
  return (
    <div className="easy-diff">
      <button className="easy-diff-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={'easy-diff-caret' + (open ? ' is-open' : '')}>›</span>
        <span className="easy-diff-file">✏️ {diff.file}</span>
        <span className="easy-diff-stat">
          {added > 0 && <span className="easy-diff-plus">+{added}</span>}
          {removed > 0 && <span className="easy-diff-minus">−{removed}</span>}
        </span>
      </button>
      {open && (
        <pre className="easy-diff-body">
          {diff.hunks.map((h, hi) => (
            <span key={hi}>
              {h.removed.map((l, li) => (
                <span key={'r' + li} className="easy-diff-del">
                  - {l}
                  {'\n'}
                </span>
              ))}
              {h.added.map((l, li) => (
                <span key={'a' + li} className="easy-diff-add">
                  + {l}
                  {'\n'}
                </span>
              ))}
            </span>
          ))}
        </pre>
      )}
    </div>
  )
}

type Row =
  | { kind: 'msg'; msg: ChatMessage }
  | { kind: 'thinking'; id: string; text: string }
  | { kind: 'activity'; entries: Activity[] }

// A whole working segment — tool calls AND file edits, in order — collapses into
// one strip. Only a real message breaks the run; thinking is ambient narration,
// so it never ends the run (otherwise one batch fragments into tiny strips).
function toRows(items: Item[]): Row[] {
  const rows: Row[] = []
  const runTarget = (): Row | undefined => {
    let i = rows.length - 1
    while (i >= 0 && rows[i].kind === 'thinking') i--
    return rows[i]
  }
  for (const it of items) {
    // A tool-heavy turn opens text blocks that never receive visible text
    // before the tool call fires — each left a padding-only sliver bubble in
    // the transcript ("... empty like that"). A settled assistant message with
    // nothing to show isn't a message; skip it here so already-saved
    // transcripts are cleaned up too. Streaming bubbles stay (the caret is the
    // content); user messages and system notes always render.
    if (
      it.kind === 'msg' &&
      it.msg.role === 'assistant' &&
      !it.msg.streaming &&
      !it.msg.system &&
      !it.msg.text.trim() &&
      !(it.msg.images && it.msg.images.length)
    ) {
      continue
    }
    if (it.kind === 'tool' || it.kind === 'diff') {
      const entry: Activity =
        it.kind === 'tool' ? { kind: 'tool', tool: it.tool } : { kind: 'diff', diff: it.diff }
      const target = runTarget()
      if (target && target.kind === 'activity') target.entries.push(entry)
      else rows.push({ kind: 'activity', entries: [entry] })
    } else {
      rows.push(it)
    }
  }
  return rows
}

/**
 * One transcript bubble, memoized. During streaming the transcript re-renders
 * every frame; without this boundary EVERY historical bubble re-ran its
 * splitAssistant regex scan and re-reconciled its whole subtree each time —
 * per-token cost that grew with conversation length. Handlers come in as
 * STABLE callbacks (ref-backed in EasyChat) so memo actually holds; only the
 * row whose `msg` object changed (the streaming one) re-renders.
 */
const MessageRow = memo(function MessageRow({
  msg,
  showEdit,
  onWheelMsg,
  onReply,
  onEdit,
  onAnswer,
  onLightbox
}: {
  msg: ChatMessage
  /** This is the last user message and no turn is running — offer Edit. */
  showEdit: boolean
  onWheelMsg: (e: React.WheelEvent<HTMLDivElement>, msg: ChatMessage) => void
  onReply: (msg: ChatMessage) => void
  onEdit: (msg: ChatMessage) => void
  onAnswer: (a: string) => void
  onLightbox: (src: string) => void
}): React.JSX.Element {
  const isAssistant = msg.role === 'assistant'
  // The regex+JSON scan runs once per text change (i.e. once per frame for the
  // streaming row, once ever for settled rows) instead of for all rows.
  const segments = useMemo(
    () => (isAssistant ? splitAssistant(msg.text) : null),
    [isAssistant, msg.text]
  )
  const at = msg.streaming ? null : msgAt(msg)
  return (
    <div
      className={`easy-msg easy-${msg.role} ${msg.system ? 'easy-system' : ''}`}
      onWheel={(e) => onWheelMsg(e, msg)}
    >
      {msg.replyTo && (
        <div className="easy-reply-quote">
          <span className="easy-reply-quote-who">
            {msg.replyTo.role === 'user' ? 'You' : 'Claude'}
          </span>
          <span className="easy-reply-quote-text">
            {msg.replyTo.text.replace(/\s+/g, ' ').trim().slice(0, 120)}
          </span>
        </div>
      )}
      {msg.images && msg.images.length > 0 && (
        <div className="easy-msg-images">
          {msg.images.map((src, ii) => (
            <img key={ii} src={src} alt="attachment" onClick={() => onLightbox(src)} />
          ))}
        </div>
      )}
      {segments
        ? segments.map((seg, si) =>
            'md' in seg ? (
              <Markdown key={si} text={seg.md} streaming={msg.streaming} />
            ) : (
              <Choices key={si} spec={seg.ask} onAnswer={onAnswer} />
            )
          )
        : msg.text}
      {msg.streaming && <span className="easy-caret" />}
      {!msg.streaming && msg.text && (
        <button
          className="easy-msg-reply"
          title="Reply to this message"
          onClick={() => onReply(msg)}
        >
          ↩
        </button>
      )}
      {isAssistant && !msg.streaming && msg.text && (
        <button
          className="easy-msg-copy"
          title="Copy"
          onClick={() => window.cove.clipboardWrite(msg.text)}
        >
          Copy
        </button>
      )}
      {showEdit && msg.text && (
        <button className="easy-msg-edit" title="Edit & resend" onClick={() => onEdit(msg)}>
          Edit
        </button>
      )}
      {at !== null && (
        <span className="easy-msg-time" title={new Date(at).toLocaleString()}>
          {msgTime(at)}
        </span>
      )}
    </div>
  )
})

export function EasyChat({
  cwd,
  workspaceId,
  chatId,
  initialSessionId,
  hideNewChat,
  browserProject,
  visible = true
}: EasyChatProps): React.JSX.Element {
  const [items, setItems] = useState<Item[]>([])
  // Armed when a turn is about to run on a session that has lost the earlier
  // conversation (a resume that failed, or a fresh process started under an
  // existing transcript). The next message out carries a recap so the agent
  // isn't answering "continue" blind. (itemsRef, the live transcript it reads,
  // is declared further down where the autosave also uses it.)
  const contextLostRef = useRef(false)
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [ready, setReady] = useState(false)
  const [agentFailed, setAgentFailed] = useState<boolean | 'missing-cwd'>(false)
  const [generating, setGenerating] = useState(false)
  const [resetKey, setResetKey] = useState(0)
  // No live claude process. Chats START here — opening a project must not cost
  // a process; the first message does (spawning then, resuming any persisted
  // session). The reaper also returns idle background chats to this state.
  // Mirrored in a ref so event handlers can wake without a stale closure.
  const [suspended, setSuspended] = useState(true)
  const suspendedRef = useRef(true)
  const [files, setFiles] = useState<string[]>([])
  /**
   * Seeded with Claude's built-ins rather than starting empty.
   *
   * The list used to be filled from two places only: this project's skill
   * folders, and the running session's init event. With no project skills and
   * no session started yet — a fresh chat, or one whose process was reaped —
   * typing "/" offered nothing at all, which reads as the feature being gone.
   * The session's own list still arrives and merges over this.
   */
  const [commands, setCommands] = useState<string[]>(() =>
    Object.keys(BUILTIN_COMMAND_DESCRIPTIONS).sort()
  )
  // name → one-line description, shown beside each "/" command in the menu.
  const [commandDescs, setCommandDescs] = useState<Record<string, string>>(() => ({
    ...BUILTIN_COMMAND_DESCRIPTIONS
  }))
  /**
   * The "Running in background" strip can be put away as a whole — one line
   * with the dot and a count — and brought back. Nothing is forgotten or
   * stopped by hiding it, which is what made the old per-pill Hide and the
   * Clear button confusing: both silently dropped jobs the app was tracking.
   */
  const [runsHidden, setRunsHidden] = useState(
    () => localStorage.getItem('cove.runsHidden') === '1'
  )
  const toggleRuns = (): void =>
    setRunsHidden((v) => {
      localStorage.setItem('cove.runsHidden', v ? '0' : '1')
      return !v
    })
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionKind, setMentionKind] = useState<'file' | 'cmd'>('file')
  const [mentionIndex, setMentionIndex] = useState(0)
  /**
   * Filesystem completions for an absolute or ~ path typed after "@", tagged
   * with the prefix they answer so a list for "/Users/a" is never shown for
   * "/Users/b" while the newer one is still on its way.
   */
  const [pathMatches, setPathMatches] = useState<{ prefix: string; list: string[] }>({
    prefix: '',
    list: []
  })
  // The other projects in the sidebar are @-mentionable too: "@levantto" used
  // to find only files in THIS project with "levantto" in their name, when the
  // thing you meant was the levantto project next door. Picking one inserts
  // its absolute path and keeps the menu open on its top level.
  const tree = useStore((s) => s.tree)
  const projectRoot = cwd.split('/.worktrees/')[0]
  const otherProjects = useMemo(
    () =>
      tree
        .flatMap((g) => g.workspaces)
        .filter((w) => w.path && w.path !== projectRoot && w.path !== cwd)
        .map((w) => ({ name: w.name, path: w.path })),
    [tree, projectRoot, cwd]
  )
  useEffect(() => {
    if (mentionKind !== 'file' || !mentionQuery || !/^[~/]/.test(mentionQuery)) return
    let stale = false
    const prefix = mentionQuery
    void window.cove.filesComplete(prefix).then((list) => {
      if (!stale) setPathMatches({ prefix, list })
    })
    return () => {
      stale = true
    }
  }, [mentionKind, mentionQuery])
  const [atBottom, setAtBottom] = useState(true)
  // Whether this worktree chat has anything unkept (uncommitted edits, or
  // commits past its base) — drives the Keep / Throw away buttons at the top of
  // the transcript. Re-checked when a turn ends; a clean chat shows nothing,
  // there's no decision to make.
  const [wtChanges, setWtChanges] = useState(false)
  const isWorktreeChat = cwd.includes('/.worktrees/')
  useEffect(() => {
    if (!isWorktreeChat) return
    const projectPath = cwd.split('/.worktrees/')[0]
    let alive = true
    const check = (): void => {
      window.cove
        .worktreeStatus(projectPath, cwd)
        .then((st) => {
          if (alive) setWtChanges(st.dirty || st.ahead > 0)
        })
        .catch(() => {})
    }
    check()
    const onIdle = (e: Event): void => {
      if ((e as CustomEvent<{ workspaceId: string }>).detail?.workspaceId === workspaceId) check()
    }
    window.addEventListener('cove:workspace-idle', onIdle)
    return () => {
      alive = false
      window.removeEventListener('cove:workspace-idle', onIdle)
    }
  }, [isWorktreeChat, cwd, workspaceId])
  // The full placeholder lists the affordances, which wraps and clips in a
  // narrow chat column; below this width only the short form fits on one line.
  const [narrowComposer, setNarrowComposer] = useState(false)
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([])
  // Non-image files dropped on the chat — shown as chips, sent as paths.
  const [pendingFiles, setPendingFiles] = useState<{ path: string; name: string }[]>([])
  // Commands the agent left running in the background. Claude mentions them in
  // prose and then moves on, so without this the only sign a deploy/build/server
  // is still going is a sentence that scrolls away.
  /** Which pill's menu is open — 'model', 'mode', 'server', or `bg-<id>`. */
  const [controlMenu, setControlMenu] = useState<string | null>(null)
  // Dismiss an open control menu (model / mode / a background-task pill) when you
  // click anywhere outside it — the expected way out of a popover. Clicks on a
  // trigger button or inside a menu are left alone (they handle themselves).
  useEffect(() => {
    if (!controlMenu) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as HTMLElement | null
      if (t && (t.closest('.easy-control-btn') || t.closest('.easy-control-menu'))) return
      setControlMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [controlMenu])
  const [bgTasks, setBgTasks] = useState<BackgroundTask[]>([])
  const bgTasksRef = useRef<BackgroundTask[]>([])
  // Sub-agents (the Task tool) currently running. They live inside the same
  // claude process — we can't see their internal steps, but we can show that one
  // is working: a pill appears when Task starts and clears when its result lands.
  const [runningAgents, setRunningAgents] = useState<
    { toolUseId: string; label: string; startedAt: number }[]
  >([])
  // The in-chat /loop: re-runs a prompt in THIS conversation until stopped —
  // continuously (re-fire when the turn ends) or on an interval. loopRef mirrors
  // it so the ref-held event handler can read the live value without a stale
  // closure; loopTimerRef holds the pending re-fire so Stop can cancel it.
  const [loop, setLoop] = useState<{
    prompt: string
    intervalMs: number | null
    count: number
  } | null>(null)
  const loopRef = useRef<typeof loop>(null)
  useEffect(() => {
    loopRef.current = loop
  }, [loop])
  const loopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const stopLoop = useCallback((): void => {
    if (loopTimerRef.current) {
      clearTimeout(loopTimerRef.current)
      loopTimerRef.current = null
    }
    loopRef.current = null
    setLoop(null)
  }, [])
  // Tail each job's output while one of their pills is open, so you watch it
  // happen rather than waiting for the agent to check on it.
  const bgOpen = controlMenu?.startsWith('bg-') ?? false
  /**
   * A clock for the "53s" in an open job's menu. Read from state rather than
   * called during render: Date.now() in the middle of rendering is impure, and
   * it also meant the age froze at whatever it was when the menu opened.
   */
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!bgOpen) return
    // No synchronous set on open: the first tick is a second away and the age
    // is already right to the second from the initial value.
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [bgOpen])
  // Retire known-duration jobs (a `sleep N` timer) once they're done — otherwise
  // manual tasks, which have no shell to report completion, pile up forever. Runs
  // whether or not the strip's menu is open, so the pills clear on their own.
  const hasExpiring = bgTasks.some((t) => t.expiresAt)
  useEffect(() => {
    if (!hasExpiring) return
    const t = window.setInterval(() => {
      const n = Date.now()
      setBgTasks((prev) => {
        const next = prev.filter((x) => !(x.expiresAt && x.expiresAt <= n))
        return next.length === prev.length ? prev : next
      })
    }, 1000)
    return () => window.clearInterval(t)
  }, [hasExpiring])
  // Tail each backgrounded task's output file: keep its live output fresh AND
  // retire it once the file shows it finished ("[exited with code N]", or a
  // completed/failed/killed status). Runs whenever there's a file to watch — not
  // only while the strip's menu is open — so a job that ends clears its own pill
  // instead of sitting on "running" forever.
  const hasOutfile = bgTasks.some((t) => t.outputPath)
  useEffect(() => {
    if (!bgOpen && !hasOutfile) return
    let alive = true
    const tick = async (): Promise<void> => {
      const paths = bgTasksRef.current.filter((t) => t.outputPath)
      for (const t of paths) {
        const text = await window.cove.bgTail?.(t.outputPath!, 8000)
        if (!alive || typeof text !== 'string') continue
        if (BG_DONE_RE.test(text)) {
          setBgTasks((prev) => prev.filter((p) => p.toolUseId !== t.toolUseId))
          continue
        }
        setBgTasks((prev) =>
          prev.map((p) =>
            p.toolUseId === t.toolUseId ? { ...p, output: text.trim(), outputAt: Date.now() } : p
          )
        )
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [bgOpen, hasOutfile])
  // Context consumed by the last turn (input + cache tokens) — a quiet running
  // gauge of how full the conversation is.
  const [ctxTokens, setCtxTokens] = useState<number | null>(null)
  // tool_use id of a BashOutput poll → the shell it's asking about, so its result
  // can retire the right task.
  const pollTargets = useRef(new Map<string, string>())
  const [dragOver, setDragOver] = useState(false)
  // A thumbnail was clicked — show it full-size in a dismissible overlay. The lock
  // hides the native browser view while it's open (a WebContentsView isn't part of
  // the DOM, so it would otherwise draw straight over the HTML lightbox).
  const [lightbox, setLightbox] = useState<string | null>(null)
  useOverlayLock(lightbox !== null)
  // WhatsApp-style quote-reply: the message the next send will reply to.
  const [replyTarget, setReplyTarget] = useState<{
    role: 'user' | 'assistant'
    text: string
  } | null>(null)
  // Accumulated horizontal wheel delta for the in-progress swipe-to-reply gesture.
  const swipeRef = useRef<{ dx: number; fired: boolean; el: HTMLElement } | null>(null)
  const swipeTimer = useRef<number | null>(null)
  const agentIdRef = useRef<string | null>(null)
  // The last human-readable line the CLI wrote to stderr this turn — Claude's
  // real diagnostic (org access disabled, invalid key…). We show it verbatim
  // when a turn errors, instead of the generic "ended the turn" note. Reset each
  // time a turn starts so a stale reason from a prior failure isn't reused.
  const lastStderrRef = useRef<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const chatRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const streamingIdRef = useRef<string | null>(null)
  // The streamed reply's text, accumulated as deltas arrive — so the done
  // notification can quote the last message. (React state lags a render, so a ref
  // is the reliable source at the finalize point.)
  const streamTextRef = useRef('')
  // Coalesce streamed deltas into ONE transcript update per animation frame.
  // Each token used to fire its own setItems — dozens of full re-renders/sec on a
  // long transcript. We buffer deltas and flush on rAF, so re-renders track the
  // display refresh, not the token rate. The finalize path sets the message's
  // full text from streamTextRef, so a not-yet-flushed tail is never lost.
  const pendingTextRef = useRef(false)
  const pendingThinkRef = useRef('')
  const flushRafRef = useRef<number | null>(null)
  const flushStream = useCallback(() => {
    flushRafRef.current = null
    const textDirty = pendingTextRef.current
    const addThink = pendingThinkRef.current
    pendingTextRef.current = false
    pendingThinkRef.current = ''
    if (!textDirty && !addThink) return
    const sid = streamingIdRef.current
    const tid = thinkingIdRef.current
    const fullText = streamTextRef.current
    setItems((prev) =>
      prev.map((it) => {
        if (textDirty && it.kind === 'msg' && it.msg.id === sid) {
          return { ...it, msg: { ...it.msg, text: fullText } }
        }
        if (addThink && it.kind === 'thinking' && it.id === tid) {
          return { ...it, text: it.text + addThink }
        }
        return it
      })
    )
  }, [])
  const scheduleFlush = useCallback(() => {
    if (flushRafRef.current !== null) return
    flushRafRef.current = requestAnimationFrame(flushStream)
  }, [flushStream])
  // Flush synchronously NOW (used at block boundaries, before streamTextRef /
  // streamingIdRef are reset for the next block — a buffered tail must land on the
  // block that produced it, not the next one).
  const drainStream = useCallback(() => {
    if (flushRafRef.current !== null) {
      cancelAnimationFrame(flushRafRef.current)
      flushRafRef.current = null
    }
    flushStream()
  }, [flushStream])
  useEffect(
    () => () => {
      if (flushRafRef.current !== null) cancelAnimationFrame(flushRafRef.current)
    },
    []
  )
  // Whether a turn is in flight, tracked as a ref so it's correct SYNCHRONOUSLY.
  // The `generating` state lags a render behind, so firing several messages in
  // quick succession made each one read `generating` as still false — so they
  // were treated as brand-new turns instead of interjections, clobbering the
  // in-flight payload and losing messages. The ref is set the instant a send
  // commits and cleared when the turn ends.
  const turnInFlightRef = useRef(false)
  // Whether this turn produced any assistant text/tool activity, so a `result`
  // that yielded nothing visible can be flagged instead of vanishing.
  const streamedThisTurnRef = useRef(false)
  /**
   * The exact payload of the turn in flight, so a turn that produces literally
   * nothing can be sent again once. Long conversations resumed from disk fail
   * their first request now and then — the CLI compacts and the same message
   * works immediately after, which is what the user was doing by hand ("first
   * message after opening is always broken").
   */
  const inFlightSendRef = useRef<{
    text: string
    images: { mediaType: string; data: string }[]
  } | null>(null)
  const retriedEmptyTurnRef = useRef(false)
  // Keep the synchronous turn-in-flight ref in step with the real state: a turn
  // ending (result), being stopped, or crashing all flip `generating` to false,
  // and this clears the ref so the next message is a fresh turn, not a phantom
  // interjection. The submit path still sets it true synchronously for rapid fire.
  useEffect(() => {
    turnInFlightRef.current = generating
  }, [generating])
  /** We stopped it on purpose — the turn's error result isn't news. */
  const interruptedRef = useRef(false)
  const thinkingIdRef = useRef<string | null>(null)
  // Session to resume so context survives restarts; updated once claude reports it.
  const resumeIdRef = useRef<string | null>(initialSessionId ?? null)
  // Messages sent while no process exists (a chat's first message, or anything
  // arriving while reaped); flushed the moment the session is up.
  const pendingSendsRef = useRef<{ text: string; images: { mediaType: string; data: string }[] }[]>(
    []
  )
  // True once a resume-based retry has already failed, so the next retry drops the
  // resume and starts fresh (a crashed session can leave a stale lock that keeps
  // failing to resume, which would otherwise loop the Retry button).
  const resumeRetriedRef = useRef(false)
  // Naming happens once per chat, so a rename is never clobbered by a late
  // suggestion; the placeholder is the only title we'll overwrite.
  const aiTitledRef = useRef(false)
  const placeholderTitleRef = useRef<string | null>(null)
  // No per-chat reset needed here: WorkspaceView keys this component by chat id,
  // so switching conversations mounts a fresh one with these refs re-initialised
  // from the incoming chat's own session.
  const registerAgent = useStore((s) => s.registerAgent)
  const isActive = useStore((s) => s.activeWorkspaceId === workspaceId)
  // Model + agent-mode pickers under the composer. Changing either respawns the
  // agent (resuming the conversation) so the new --model / --permission-mode take
  // effect immediately without losing context.
  const model = useStore((s) => s.model)
  const setModel = useStore((s) => s.setModel)
  const permissionMode = useStore((s) => s.permissionMode)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  /** The model the running session reports (from claude's init event). */
  const [activeModel, setActiveModel] = useState<string | null>(null)

  // Load files (@-mentions) and skills/commands (/-commands) once.
  useEffect(() => {
    // Directories come back too (trailing '/'), but you mention a file.
    window.cove.filesList(cwd).then((fs) => setFiles(fs.filter((f) => !f.endsWith('/'))))
    window.cove.skillsList(cwd).then((list) => {
      // Merge, never replace: this used to overwrite the pool with the project's
      // own skills, so a project with none — which is most of them — wiped the
      // built-ins straight back out and "/" offered nothing at all.
      setCommands((prev) => Array.from(new Set([...prev, ...list.map((s) => s.name)])).sort())
      setCommandDescs((prev) => {
        const next = { ...prev }
        for (const s of list) if (s.description) next[s.name] = s.description
        return next
      })
    })
  }, [cwd])

  // Restore the persisted transcript on mount, then save it (debounced) as it
  // changes — so the conversation is still here after Superagent is reopened.
  const hydratedRef = useRef(false)
  useEffect(() => {
    let alive = true
    // Saving stays blocked until this chat's own transcript has landed, so an
    // empty first render can never be written over real data.
    hydratedRef.current = false
    window.cove.chatLoad(chatId).then((json) => {
      if (!alive) return
      if (json) {
        try {
          const saved = JSON.parse(json) as Item[]
          if (saved.length) setItems(saved)
        } catch {
          // Ignore a corrupt blob — start fresh.
        }
      }
      // This chat wanted its own checkout but git refused (no commits yet, or
      // an index it won't branch from). Say so once, inline — a small system
      // line beats an alert() the user has to dismiss.
      if (localStorage.getItem(`wtFallback:${chatId}`) === '1') {
        localStorage.removeItem(`wtFallback:${chatId}`)
        setItems((prev) => [
          ...prev,
          {
            kind: 'msg',
            msg: {
              id: `sys-${Date.now()}`,
              at: Date.now(),
              role: 'assistant',
              text: 'This project has no commits yet, so this chat works directly in the folder.',
              system: true
            }
          }
        ])
      }
      hydratedRef.current = true
    })
    return () => {
      alive = false
    }
  }, [chatId])

  /** Last payload actually written, so an unchanged transcript is never rewritten. */
  const lastSavedRef = useRef('')
  const saveTranscript = useCallback((): void => {
    // Never write without a chat to write to, and never before this chat's own
    // transcript has loaded — either would persist an empty list over real data.
    if (!chatId || !hydratedRef.current) return
    // Persist a clean copy — no mid-stream flags to reanimate on reload.
    const clean = itemsRef.current.map((it) =>
      it.kind === 'msg' && it.msg.streaming ? { ...it, msg: { ...it.msg, streaming: false } } : it
    )
    const json = JSON.stringify(clean)
    if (json === lastSavedRef.current) return
    lastSavedRef.current = json
    window.cove.chatSave(chatId, json)
  }, [chatId])

  useEffect(() => {
    // Idle edits (sending, editing, clearing) settle quickly.
    if (!chatId || !hydratedRef.current || generating) return
    const t = setTimeout(saveTranscript, 600)
    return () => clearTimeout(t)
  }, [items, chatId, generating, saveTranscript])

  /**
   * Streaming rewrote the WHOLE transcript every 400ms — with a long chat that
   * is megabytes of JSON.stringify on the main thread, several times a second:
   * 2.4 GB of disk writes in four hours (macOS filed a diagnostic) and a UI that
   * stutters while the agent types. A checkpoint every few seconds loses nothing
   * that matters — the final save lands the moment the turn ends.
   */
  useEffect(() => {
    if (!generating || !chatId) return
    const iv = setInterval(saveTranscript, 5000)
    return () => {
      clearInterval(iv)
      saveTranscript()
    }
  }, [generating, chatId, saveTranscript])

  // Paste a screenshot/image into the composer.
  const attachImage = (file: File): void => {
    const reader = new FileReader()
    reader.onload = (): void => {
      const url = reader.result as string
      const data = url.split(',')[1] ?? ''
      setPendingImages((prev) => [...prev, { mediaType: file.type, data, url }])
    }
    reader.readAsDataURL(file)
  }

  // Cmd+V an image anywhere in the active chat (not only when the input is
  // focused) — a document-level listener, scoped to the visible workspace.
  useEffect(() => {
    // Only the on-screen chat captures document-level paste/dictation/inject
    // events — busy siblings stay mounted but hidden, and must not react.
    if (!isActive || !visible) return
    const onDocPaste = (e: ClipboardEvent): void => {
      const imgItems = [...(e.clipboardData?.items ?? [])].filter((it) =>
        it.type.startsWith('image/')
      )
      if (imgItems.length === 0) return // let normal text paste happen
      e.preventDefault()
      for (const item of imgItems) {
        const file = item.getAsFile()
        if (file) attachImage(file)
      }
    }
    document.addEventListener('paste', onDocPaste)
    return () => document.removeEventListener('paste', onDocPaste)
    // attachImage only closes over stable setState, so re-subscribing per render is unnecessary.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, visible])

  // A crop from the snip tool (WorkspaceView) lands here — attach it like a
  // pasted image and drop the cursor in the box so you can describe the problem
  // right away. Only the on-screen chat reacts (busy siblings stay hidden).
  useEffect(() => {
    if (!isActive || !visible) return
    const onSnip = (e: Event): void => {
      const url = (e as CustomEvent<{ url: string }>).detail?.url
      if (!url) return
      void fetch(url)
        .then((r) => r.blob())
        .then((blob) => {
          attachImage(
            new File([blob], `snip-${Date.now()}.png`, { type: blob.type || 'image/png' })
          )
          inputRef.current?.focus()
        })
    }
    window.addEventListener('cove:attach-image', onSnip)
    return () => window.removeEventListener('cove:attach-image', onSnip)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, visible])

  // Drag a file onto the chat: images attach (like a paste); other files become
  // a file chip in the composer — the same 📎 chip a file dropped from the tree
  // gets — rather than dumping a raw path into the text you're writing.
  // Attach a set of files: images inline (like a paste), other files as a 📎 chip
  // carrying the path the agent can read. Shared by drag-drop and the attach button.
  const attachFiles = (files: File[]): void => {
    if (files.length === 0) return
    const dropped: { path: string; name: string }[] = []
    for (const file of files) {
      if (file.type.startsWith('image/')) attachImage(file)
      else {
        const p = window.cove.getPathForFile?.(file)
        if (p) dropped.push({ path: p, name: file.name || p.split('/').pop() || p })
      }
    }
    if (dropped.length > 0) {
      // Dedupe against what's already staged, so attaching the same file twice
      // doesn't chip it twice.
      setPendingFiles((prev) => {
        const have = new Set(prev.map((f) => f.path))
        return [...prev, ...dropped.filter((f) => !have.has(f.path))]
      })
      inputRef.current?.focus()
    }
  }
  const fileInputRef = useRef<HTMLInputElement>(null)
  const onDrop = (e: React.DragEvent): void => {
    const files = [...(e.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    e.preventDefault()
    setDragOver(false)
    attachFiles(files)
  }

  // Track the drop-hint from the window so it can't get stuck: show it only while a
  // file is dragged over THIS chat, and always clear it on drop/leave/end.
  useEffect(() => {
    const onOver = (e: DragEvent): void => {
      const overChat = !!e.target && chatRef.current?.contains(e.target as Node)
      setDragOver(!!overChat && !!e.dataTransfer?.types.includes('Files'))
    }
    const clear = (): void => setDragOver(false)
    const onLeave = (e: DragEvent): void => {
      if (e.relatedTarget === null) setDragOver(false) // pointer left the window
    }
    window.addEventListener('dragover', onOver)
    window.addEventListener('drop', clear)
    window.addEventListener('dragend', clear)
    window.addEventListener('dragleave', onLeave)
    return () => {
      window.removeEventListener('dragover', onOver)
      window.removeEventListener('drop', clear)
      window.removeEventListener('dragend', clear)
      window.removeEventListener('dragleave', onLeave)
    }
  }, [])

  // Grow the input with its content, up to the CSS max-height.
  const autoResize = (): void => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }

  // Insert a file reference (clicked in the file tree) into the composer — don't send.
  useEffect(() => {
    const onInsert = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { workspaceId: string; text: string }
      if (detail.workspaceId !== workspaceId || !visible) return
      setInput((prev) => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + detail.text)
      const el = inputRef.current
      if (el) {
        el.focus()
        requestAnimationFrame(() => {
          el.style.height = 'auto'
          el.style.height = Math.min(el.scrollHeight, 160) + 'px'
        })
      }
    }
    window.addEventListener('cove:insert-reference', onInsert)
    return () => window.removeEventListener('cove:insert-reference', onInsert)
  }, [workspaceId, visible])

  /**
   * "Work on this" from the list: send the item straight through as the prompt.
   * Unlike a file reference this does submit — the button says it will, and a
   * prefilled composer you then have to press Enter on is a worse version of
   * the same thing.
   */
  useEffect(() => {
    const onWorkOn = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { workspaceId: string; text: string }
      if (detail.workspaceId !== workspaceId || !visible) return
      submitRef.current?.(detail.text)
    }
    window.addEventListener('cove:work-on', onWorkOn)
    return () => window.removeEventListener('cove:work-on', onWorkOn)
  }, [workspaceId, visible])

  // Detect a "/command" at the start, or an "@file" at the caret, for the dropdown.
  const updateMention = (value: string): void => {
    const cmd = /^\/(\S*)$/.exec(value)
    if (cmd) {
      setMentionKind('cmd')
      setMentionQuery(cmd[1])
      setMentionIndex(0)
      return
    }
    const el = inputRef.current
    const caret = el ? el.selectionStart : value.length
    const m = /(^|\s)@([\w./~-]*)$/.exec(value.slice(0, caret))
    setMentionKind('file')
    setMentionQuery(m ? m[2] : null)
    setMentionIndex(0)
  }

  /** One row of the @ / slash menu: what gets inserted, and how it reads. */
  interface Mention {
    text: string
    label: string
    hint?: string
  }
  const mentionMatches: Mention[] =
    mentionQuery === null
      ? []
      : (() => {
          const q = mentionQuery.toLowerCase()
          if (mentionKind === 'cmd') {
            const pool = q === '' ? commands : commands.filter((c) => c.toLowerCase().includes(q))
            return pool.slice(0, 8).map((c) => ({ text: c, label: c }))
          }
          // An absolute or ~ path: the disk, not the project.
          if (/^[~/]/.test(mentionQuery)) {
            // The answer for exactly this prefix; until it lands, the previous
            // list narrowed by what has been typed since.
            const list =
              pathMatches.prefix === mentionQuery
                ? pathMatches.list
                : pathMatches.list.filter((p) => p.toLowerCase().startsWith(q))
            return list.slice(0, 8).map((p) => ({ text: p, label: p }))
          }
          // Other projects rank first — there are few and a name match is
          // almost always the one you meant — then this project's files.
          const projects =
            q === ''
              ? []
              : otherProjects
                  .filter((p) => p.name.toLowerCase().includes(q))
                  .map((p) => ({
                    text: p.path + '/',
                    label: p.name + '/',
                    hint: `project · ${p.path}`
                  }))
          const own = (q === '' ? files : files.filter((f) => f.toLowerCase().includes(q))).map(
            (f) => ({ text: f, label: f })
          )
          return [...projects, ...own].slice(0, 8)
        })()

  const pickMention = (item: Mention): void => {
    if (mentionKind === 'cmd') {
      setInput(`/${item.text} `)
      setMentionQuery(null)
    } else {
      // Replace the trailing "@query" with "@path ". A folder gets no trailing
      // space and keeps the menu open, now listing what's inside it.
      const folder = item.text.endsWith('/')
      setInput(input.replace(/@[\w./~-]*$/, `@${item.text}${folder ? '' : ' '}`))
      setMentionQuery(folder ? item.text : null)
      setMentionIndex(0)
    }
    inputRef.current?.focus()
  }

  const dictation = useDictation()
  const micTitle =
    dictation.state === 'recording'
      ? 'Listening — release (or click) to transcribe, Esc to discard'
      : dictation.state === 'loading-model'
        ? `Downloading the speech model, one time only${
            dictation.progress > 0 ? ` — ${Math.round(dictation.progress)}%` : ''
          }`
        : dictation.state === 'transcribing'
          ? 'Turning your speech into text…'
          : 'Hold to dictate (⌥Space)'

  // Latest transcript for callbacks that must not re-subscribe on every message.
  // Assigned during render, not in an effect: the periodic save reads it from an
  // interval and must never write a transcript that is a render behind.
  const itemsRef = useRef<Item[]>(items)
  itemsRef.current = items

  const nameConversation = useCallback(async (): Promise<void> => {
    const store = useStore.getState()
    const chat = store.chats[workspaceId]?.find((c) => c.id === chatId)
    // Only replace our own placeholder — anything else is the user's wording.
    if (!chat || (chat.title && chat.title !== placeholderTitleRef.current)) return

    const firstUser = itemsRef.current.find((it) => it.kind === 'msg' && it.msg.role === 'user')
    const firstReply = itemsRef.current.find(
      (it) => it.kind === 'msg' && it.msg.role === 'assistant' && it.msg.text.trim()
    )
    if (!firstUser || firstUser.kind !== 'msg') return
    const excerpt =
      `User: ${firstUser.msg.text.slice(0, 600)}` +
      (firstReply && firstReply.kind === 'msg'
        ? `\n\nAssistant: ${firstReply.msg.text.slice(0, 600)}`
        : '')

    const title = await window.cove.agentSuggestTitle(cwd, excerpt)
    if (!title) return
    const latest = useStore.getState().chats[workspaceId]?.find((c) => c.id === chatId)
    if (latest && latest.title !== placeholderTitleRef.current) return // renamed while we waited
    // Through renameChat, so a worktree chat's branch follows the title too.
    await useStore.getState().renameChat(workspaceId, chatId, title)
  }, [cwd, workspaceId, chatId])

  // Claude's tasks, accumulated from TaskCreate/TaskUpdate and mirrored (in
  // insertion order) into the store the Tasks panel reads. Kept per chat at
  // module level: a remount (switching chats and back) must not reset the map,
  // because the CLI session resumes with its task ids intact and updates against
  // an empty map would be orphaned.
  const tasks = useRef<Map<string, TodoItem>>(
    taskStores.get(chatId) ?? taskStores.set(chatId, new Map()).get(chatId)!
  )
  // tool_use id of an in-flight TaskCreate → our provisional key, so the tool's
  // RESULT ("Task #7 created") can re-key the entry to the id Claude will
  // actually use in later TaskUpdates.
  const taskCreates = useRef(new Map<string, string>())
  const syncTasks = useCallback((): void => {
    useStore.getState().setTodos(
      chatId,
      [...tasks.current.values()].map((t) => ({ ...t }))
    )
  }, [chatId])

  const handleEvent = useCallback(
    (event: Record<string, unknown>) => {
      const type = event.type as string

      if (type === 'system' && (event.subtype as string) === 'init') {
        setReady(true)
        // What the CLI actually resolved to. With the picker on "Default" this
        // is the only way to know which model you are spending — the reason
        // "Default" could silently be Fable and the limit message came as a
        // surprise.
        const m = event.model as string | undefined
        if (m) setActiveModel(m)
        // Claude reports every slash command this session can actually run (built-ins
        // like /compact, /review plus the user's own skills; interactive TUI-only ones
        // are already excluded). Fold them into the "/" autocomplete pool so the menu
        // covers all of Claude's commands, not just the skill folders we scanned.
        const slash = event.slash_commands as string[] | undefined
        if (Array.isArray(slash) && slash.length) {
          setCommands((prev) => Array.from(new Set([...prev, ...slash])).sort())
          // Fill in descriptions for the built-ins (skills already brought their own).
          setCommandDescs((prev) => {
            const next = { ...prev }
            for (const name of slash)
              if (!next[name] && BUILTIN_COMMAND_DESCRIPTIONS[name])
                next[name] = BUILTIN_COMMAND_DESCRIPTIONS[name]
            return next
          })
        }
        // Remember the session id so we can resume this conversation next launch.
        const sid = event.session_id as string | undefined
        if (sid && sid !== resumeIdRef.current) {
          resumeIdRef.current = sid
          window.cove.chatUpdate(chatId, { claudeSessionId: sid })
          useStore.getState().touchChat(workspaceId, chatId, { claudeSessionId: sid })
        }
        return
      }

      if (type === 'stream_event') {
        const ev = event.event as Record<string, unknown>
        const evType = ev?.type as string
        if (evType === 'content_block_start') {
          // Land any buffered tail on the block that's ending before we switch
          // streamingIdRef / reset streamTextRef for the new one.
          drainStream()
          const block = ev.content_block as Record<string, unknown>
          if (block?.type === 'text') {
            // Begin a new streaming assistant message.
            const id = `a-${Date.now()}-${Math.random()}`
            streamingIdRef.current = id
            streamTextRef.current = ''
            streamedThisTurnRef.current = true
            setThinking(false)
            setItems((prev) => [
              ...prev,
              {
                kind: 'msg',
                msg: { id, role: 'assistant', text: '', streaming: true, at: Date.now() }
              }
            ])
          } else if (block?.type === 'thinking') {
            const id = `t-${Date.now()}-${Math.random()}`
            thinkingIdRef.current = id
            setItems((prev) => [...prev, { kind: 'thinking', id, text: '' }])
          }
        } else if (evType === 'content_block_delta') {
          const delta = ev.delta as Record<string, unknown>
          if (delta?.type === 'text_delta') {
            const chunk = delta.text as string
            streamTextRef.current += chunk
            // Buffer; the rAF flush applies streamTextRef's full text to the row.
            pendingTextRef.current = true
            scheduleFlush()
          } else if (delta?.type === 'thinking_delta') {
            const chunk = (delta.thinking as string) ?? ''
            pendingThinkRef.current += chunk
            scheduleFlush()
          }
        } else if (evType === 'content_block_stop') {
          // Land the block's buffered tail, then stop appending to a thinking block.
          drainStream()
          thinkingIdRef.current = null
        }
        return
      }

      if (type === 'assistant') {
        const msg = event.message as Record<string, unknown>
        // Per-request usage: input + cache tokens on THIS message is the size of
        // the prompt Claude just carried, i.e. the live context. (The result
        // event's usage sums every request in the turn — a tool-heavy turn can
        // total several times the window, which is how the meter reached 166%.)
        const mu = msg?.usage as Record<string, number> | undefined
        if (mu) {
          const live =
            (mu.input_tokens ?? 0) +
            (mu.cache_read_input_tokens ?? 0) +
            (mu.cache_creation_input_tokens ?? 0)
          if (live > 0) setCtxTokens(live)
        }
        const content = (msg?.content as Record<string, unknown>[]) || []
        // Some assistant messages arrive whole rather than streamed — most notably
        // API-error notices like "You've reached your Fable 5 limit… switch models
        // with /model" (rate_limit). Text normally streams via stream_event, so if
        // a text block shows up here that we never streamed, surface it — otherwise
        // the turn looks empty and the user never sees why it stopped.
        if (!streamingIdRef.current) {
          const wholeText = content
            .filter((b) => b.type === 'text')
            .map((b) => (b.text as string) || '')
            .join('')
            .trim()
          if (wholeText) {
            streamedThisTurnRef.current = true
            const isApiError = msg?.isApiErrorMessage === true
            if (!isApiError && wholeText.trim()) {
              // First non-empty line of the reply — the "what finished" for the
              // done notification.
              const line =
                wholeText
                  .trim()
                  .split('\n')
                  .find((l) => l.trim()) ?? ''
              window.cove.chatLastReply(workspaceId, line.replace(/[#*_`>]/g, '').trim())
            }
            setItems((prev) => [
              ...prev,
              {
                kind: 'msg',
                msg: {
                  id: `a-${Date.now()}-${Math.random()}`,
                  at: Date.now(),
                  role: 'assistant',
                  text: isApiError ? `⚠ ${wholeText}` : wholeText,
                  system: isApiError
                }
              }
            ])
          }
        }
        for (const block of content) {
          if (block.type === 'tool_use') {
            setThinking(false)
            streamedThisTurnRef.current = true
            const name = block.name as string
            const id = block.id as string
            // A tool that writes to disk means the preview might genuinely have
            // changed, so the idle-reload should fire. A turn with none of these
            // (a plain question) leaves the flag unset and the page is left alone.
            if (FILE_WRITE_TOOLS.has(name)) {
              useStore.getState().markPreviewDirty(workspaceId)
            }
            // Claude's task tools drive the Tasks panel. TaskCreate adds a task
            // (id assigned in creation order, matching Claude's #N), TaskUpdate
            // moves its status. We accumulate them and mirror into the store.
            if (name === 'TaskCreate') {
              const inp = block.input as { subject?: string; activeForm?: string }
              // Provisional until the tool result reports the real id. Guessing
              // "creation order" here and hoping it matched Claude's numbering is
              // what used to strand the panel at pending: one drifted id and every
              // later TaskUpdate was silently dropped.
              const provisional = `tmp-${id}`
              taskCreates.current.set(id, provisional)
              tasks.current.set(provisional, {
                content: inp.subject ?? '(task)',
                status: 'pending',
                activeForm: inp.activeForm
              })
              syncTasks()
            } else if (name === 'TaskUpdate') {
              const inp = block.input as {
                taskId?: string
                status?: TodoItem['status'] | 'deleted'
                subject?: string
                activeForm?: string
              }
              if (inp.taskId) {
                let t = tasks.current.get(inp.taskId)
                if (!t) {
                  // Unknown id — a task from before this panel was watching. A
                  // placeholder keeps the counts honest; dropping the update is
                  // how the panel gets stuck showing work as pending forever.
                  t = { content: inp.subject ?? `Task #${inp.taskId}`, status: 'pending' }
                  tasks.current.set(inp.taskId, t)
                }
                if (inp.subject) t.content = inp.subject
                if (inp.activeForm) t.activeForm = inp.activeForm
                if (inp.status === 'deleted') tasks.current.delete(inp.taskId)
                else if (inp.status) {
                  if (inp.status === 'completed' && t.status !== 'completed') {
                    window.cove.eventsRecord?.('task-done', workspaceId)
                  }
                  t.status = inp.status
                }
                syncTasks()
              }
            }
            // Backgrounded shells outlive the turn that started them, so track them
            // until something says they're finished.
            const inp = (block.input ?? {}) as Record<string, unknown>
            // The agent's own one-line "what this does", the same text the
            // terminal shows next to the command — far clearer than the command.
            const description =
              typeof inp.description === 'string' && inp.description.trim()
                ? inp.description.trim()
                : undefined
            if (name === 'Bash' && inp.run_in_background) {
              const command = typeof inp.command === 'string' ? inp.command : ''
              setBgTasks((prev) => [
                ...prev,
                { toolUseId: id, command, description, startedAt: Date.now() }
              ])
            } else if (
              name === 'Bash' &&
              typeof inp.command === 'string' &&
              isBackgrounded(inp.command)
            ) {
              // Backgrounded the old-fashioned way (`… &`). The shell returns
              // right away but the job keeps going, so without this it runs
              // invisibly — the "it's running in the background but you can't see
              // it" case. No handle to poll, so it's manual-dismiss only.
              const command = inp.command
              const dur = sleepDurationSec(command)
              const startedAt = Date.now()
              setBgTasks((prev) => [
                ...prev,
                {
                  toolUseId: id,
                  command,
                  description,
                  startedAt,
                  manual: true,
                  // A sleep timer finishes at a known time; give it a small
                  // buffer, then it clears itself instead of piling up.
                  ...(dur != null ? { expiresAt: startedAt + dur * 1000 + 1500 } : {})
                }
              ])
            } else if (name === 'BashOutput' && typeof inp.bash_id === 'string') {
              pollTargets.current.set(id, inp.bash_id)
            } else if (name === 'KillShell' && typeof inp.shell_id === 'string') {
              const killed = inp.shell_id
              setBgTasks((prev) => prev.filter((t) => t.shellId !== killed))
            } else if (name === 'Monitor') {
              // Claude Code's Monitor tool: a long-running background watch that
              // is NOT a Bash job, so it wasn't tracked — which meant the idle
              // reaper (guarded on bgTasks.length) didn't know to spare the chat,
              // and the monitor died when you switched away. Track it so its own
              // work keeps the process resident. A non-persistent monitor ends at
              // its timeout and clears then; a persistent one runs until stopped,
              // so it has no expiry (and keeps the chat alive, as intended).
              const label =
                (typeof inp.description === 'string' && inp.description.trim()) || 'monitor'
              const startedAt = Date.now()
              const timeoutMs = typeof inp.timeout_ms === 'number' ? inp.timeout_ms : null
              const persistent = inp.persistent === true
              setBgTasks((prev) => [
                ...prev,
                {
                  toolUseId: id,
                  command: label,
                  description: label,
                  startedAt,
                  manual: true,
                  ...(!persistent && timeoutMs ? { expiresAt: startedAt + timeoutMs + 2000 } : {})
                }
              ])
            } else if (name === 'Task') {
              // A sub-agent just started. Its result block clears the pill.
              const label =
                (typeof inp.description === 'string' && inp.description.trim()) ||
                (typeof inp.subagent_type === 'string' && inp.subagent_type) ||
                'sub-agent'
              setRunningAgents((prev) => [
                ...prev,
                { toolUseId: id, label: String(label), startedAt: Date.now() }
              ])
            }
            const diff = toolDiff(name, id, block.input)
            setItems((prev) => [
              ...prev,
              diff
                ? { kind: 'diff', diff }
                : { kind: 'tool', tool: { id, name, detail: toolDetail(block.input) } }
            ])
          }
        }
        // Finalize the streaming text message.
        const sid = streamingIdRef.current
        if (sid) {
          // Drop any pending rAF and write the COMPLETE streamed text here — this
          // is the authoritative final state, so a delta buffered but not yet
          // flushed at end-of-turn can't be lost.
          if (flushRafRef.current !== null) {
            cancelAnimationFrame(flushRafRef.current)
            flushRafRef.current = null
          }
          pendingTextRef.current = false
          const fullText = streamTextRef.current
          setItems((prev) =>
            prev.map((it) =>
              it.kind === 'msg' && it.msg.id === sid
                ? { ...it, msg: { ...it.msg, text: fullText, streaming: false } }
                : it
            )
          )
          // Capture the streamed reply for the done notification. This was ONLY
          // done in the non-streaming branch above, so a normal (streamed) reply
          // never updated it — the notification then quoted whatever last came
          // through un-streamed (often an API/limit error), never the real reply.
          const isApiError = (msg?.isApiErrorMessage as boolean) === true
          const text = streamTextRef.current.trim()
          if (text && !isApiError) {
            const line = text.split('\n').find((l) => l.trim()) ?? ''
            if (line) window.cove.chatLastReply(workspaceId, line.replace(/[#*_`>]/g, '').trim())
          }
        }
        return
      }

      // Tool results (Bash output etc.) arrive as `user` events. Scan them for a
      // dev server the agent just started and offer a one-click preview.
      if (type === 'user') {
        const content = (event.message as { content?: unknown })?.content
        if (Array.isArray(content)) {
          for (const block of content as Record<string, unknown>[]) {
            if (block.type !== 'tool_result') continue
            const c = block.content
            const text =
              typeof c === 'string'
                ? c
                : Array.isArray(c)
                  ? (c as Record<string, unknown>[])
                      .map((p) => (typeof p.text === 'string' ? p.text : ''))
                      .join('\n')
                  : ''
            for (const port of extractPorts(text)) {
              useStore.getState().addPort(workspaceId, port)
            }
            // Same results carry the background-shell bookkeeping: the starting
            // Bash call answers with the shell's id, and a later BashOutput poll
            // says whether it has finished.
            const resultFor = typeof block.tool_use_id === 'string' ? block.tool_use_id : null
            if (resultFor) {
              // A sub-agent finished — drop its pill.
              setRunningAgents((prev) => prev.filter((a) => a.toolUseId !== resultFor))
              // TaskCreate's result carries the assigned id ("Task #7 created…").
              // Re-key our provisional entry to it so later TaskUpdates land.
              const provisional = taskCreates.current.get(resultFor)
              if (provisional) {
                taskCreates.current.delete(resultFor)
                const m = text.match(/Task #?(\d+)/i)
                if (m) {
                  const next = new Map<string, TodoItem>()
                  for (const [k, v] of tasks.current) next.set(k === provisional ? m[1] : k, v)
                  tasks.current = next
                  taskStores.set(chatId, next) // keep the remount-survival copy current
                  syncTasks()
                }
              }
              const polled = pollTargets.current.get(resultFor)
              if (polled) {
                pollTargets.current.delete(resultFor)
                if (BG_DONE_RE.test(text)) {
                  setBgTasks((prev) => prev.filter((t) => t.shellId !== polled))
                } else {
                  // Keep the tail of what the agent last read, so opening the
                  // strip shows what the job is actually doing.
                  const tail = text.trim().slice(-4000)
                  if (tail)
                    setBgTasks((prev) => {
                      // Match on the shell handle when we managed to parse one
                      // out of the Bash result; with a single job in flight the
                      // poll can only be about that one, so don't lose the
                      // output just because the handle never parsed.
                      const byShell = prev.some((t) => t.shellId === polled)
                      return prev.map((t) =>
                        byShell
                          ? t.shellId === polled
                            ? { ...t, output: tail, outputAt: Date.now() }
                            : t
                          : prev.length === 1
                            ? {
                                ...t,
                                shellId: t.shellId ?? polled,
                                output: tail,
                                outputAt: Date.now()
                              }
                            : t
                      )
                    })
                }
              }
              setBgTasks((prev) =>
                prev.map((t) => {
                  if (t.toolUseId !== resultFor) return t
                  const next = { ...t }
                  if (!next.shellId) {
                    const m = text.match(BG_SHELL_ID_RE)
                    if (m) next.shellId = m[1]
                  }
                  if (!next.outputPath) {
                    const f = text.match(BG_OUTFILE_RE)
                    if (f) next.outputPath = f[1]
                  }
                  return next
                })
              )
            }
          }
        }
        return
      }

      if (type === 'result') {
        const u = (event as { usage?: Record<string, number> }).usage
        if (u) {
          const processed =
            (u.input_tokens ?? 0) +
            (u.cache_read_input_tokens ?? 0) +
            (u.cache_creation_input_tokens ?? 0)
          // Everything this turn processed — the dashboard's chart, not the meter.
          const total = processed + (u.output_tokens ?? 0)
          if (total > 0) window.cove.eventsRecord?.('tokens', workspaceId, total)
        }
        // A completed turn means the session genuinely works — clear the guard so
        // a future crash gets a resume-retry before falling back to fresh.
        resumeRetriedRef.current = false
        streamingIdRef.current = null
        // First turn is done: let the agent name the conversation, replacing the
        // opening-message placeholder. Skipped if the user already renamed it.
        if (!aiTitledRef.current) {
          aiTitledRef.current = true
          void nameConversation()
        }
        // A `result` marks the end of the turn (mid-turn messages steer the same
        // turn, so there's exactly one). Any message sent after this just starts a
        // fresh turn on its own.
        setThinking(false)
        setGenerating(false)
        // NB: we deliberately do NOT clear runningAgents here. A sub-agent the
        // agent spawned can keep running after the turn ends (it will say so),
        // and clearing on turn-end hid that work. Pills clear when their own
        // result block arrives, on interrupt/exit, or when the next turn starts.
        // /loop (continuous): the turn finished, so run the prompt again — unless
        // the user stopped it, we hit the safety cap, or the turn was interrupted.
        const lp = loopRef.current
        if (lp && lp.intervalMs === null && !interruptedRef.current) {
          if (lp.count >= LOOP_CAP) {
            loopRef.current = null
            setLoop(null)
            setItems((prev) => [
              ...prev,
              {
                kind: 'msg',
                msg: {
                  id: `sys-${Date.now()}`,
                  at: Date.now(),
                  role: 'assistant',
                  text: `⏹ Loop stopped after ${LOOP_CAP} runs (safety cap).`,
                  system: true
                }
              }
            ])
          } else {
            const next = { ...lp, count: lp.count + 1 }
            loopRef.current = next
            setLoop(next)
            if (loopTimerRef.current) clearTimeout(loopTimerRef.current)
            loopTimerRef.current = setTimeout(() => {
              if (loopRef.current) submitRef.current?.(next.prompt)
            }, 900)
          }
        }
        // Surface a failed or empty turn. Without this the app silently swallows an
        // error result (usage limit, max turns, an execution/auth error) — so a
        // message like "continue" looks like it did nothing at all.
        const isError =
          (event.is_error as boolean) ||
          (typeof event.subtype === 'string' && event.subtype !== 'success')
        // A turn we cut short reports itself as an error; that's expected, not
        // something to put in front of the user.
        if (interruptedRef.current) {
          interruptedRef.current = false
          streamedThisTurnRef.current = false
          return
        }
        const sub = event.subtype as string | undefined
        const agentId = agentIdRef.current
        // Nothing at all came back — no text, no tools, no error detail. Send the
        // message again once rather than making the user do it; only when the turn
        // was completely empty, so a partially-completed turn is never repeated.
        const emptyTurn = !streamedThisTurnRef.current && !event.is_error
        if (emptyTurn && !retriedEmptyTurnRef.current && inFlightSendRef.current && agentId) {
          const again = inFlightSendRef.current
          retriedEmptyTurnRef.current = true
          window.cove.agentSend(agentId, again.text, again.images)
          setGenerating(true)
          setThinking(true)
          return
        }
        // A turn that errored mid-tool (stop_reason=tool_use, no result) is a
        // transient CLI hiccup — it shows up more when two sessions in one folder
        // run at once. "continue" recovers it, so do that once automatically
        // instead of dropping a jargon-filled error on the user; if it happens
        // again this turn, fall through and actually say something.
        if (sub === 'error_during_execution' && !retriedEmptyTurnRef.current && agentId) {
          retriedEmptyTurnRef.current = true
          window.cove.agentSend(agentId, 'continue', [])
          setGenerating(true)
          setThinking(true)
          return
        }
        if (isError || !streamedThisTurnRef.current) {
          // If the CLI wrote a real reason to stderr this turn — an org-access or
          // auth problem, a bad key — that's exactly what the user needs to see,
          // so show it verbatim instead of guessing with the generic note.
          const real = isError ? lastStderrRef.current : null
          let note = real
            ? real
            : 'Claude ended the turn without a response. Try sending your message again.'
          if (!real && sub === 'error_max_turns')
            note =
              'Claude reached its step limit for this turn. Send “continue” to let it keep going.'
          else if (!real && sub === 'error_during_execution')
            note = 'Claude hit an error partway through this turn. Send “continue” to retry.'
          const errs = event.errors as unknown[] | undefined
          // The CLI's internal diagnostics ([ede_diagnostic] …) mean nothing to
          // the user; only attach error detail for cases where it's actionable,
          // and never when we already have the real stderr reason.
          const detail =
            !real && sub !== 'error_during_execution' && Array.isArray(errs) && errs.length
              ? ' (' +
                errs
                  .map((e) => (typeof e === 'string' ? e : JSON.stringify(e)))
                  .join('; ')
                  .slice(0, 200) +
                ')'
              : ''
          const noteText = `⚠ ${note}${detail}`
          setItems((prev) => {
            // Don't stack the same notice twice in a row. A flaky session can end
            // several turns the same empty way; one bubble reads as a state, a
            // column of identical bubbles reads as broken.
            const last = prev[prev.length - 1]
            if (last?.kind === 'msg' && last.msg.system && last.msg.text === noteText) {
              return prev
            }
            return [
              ...prev,
              {
                kind: 'msg',
                msg: {
                  id: `sys-${Date.now()}`,
                  at: Date.now(),
                  role: 'assistant',
                  text: noteText,
                  system: true
                }
              }
            ]
          })
        }
        streamedThisTurnRef.current = false
      }
    },
    [workspaceId, chatId, nameConversation, syncTasks]
  )

  // A compact recap of the conversation so far, to re-seed a session that lost
  // its memory. Recent turns only, each clipped — enough for "continue" to mean
  // something without blowing the context window.
  const buildRecap = (): string => {
    const lines: string[] = []
    for (const it of itemsRef.current) {
      if (it.kind !== 'msg') continue
      const m = it.msg
      if (m.system || !m.text || !m.text.trim()) continue
      lines.push(
        `${m.role === 'user' ? 'User' : 'Claude'}: ${m.text.replace(/\s+/g, ' ').trim().slice(0, 700)}`
      )
    }
    if (lines.length === 0) return ''
    return lines.slice(-24).join('\n')
  }

  // Send to the agent, transparently prepending a recap the first time we send
  // after context was lost — so a resumed-but-empty session answers with the
  // conversation in hand instead of "I don't have prior context".
  const sendToAgent = (
    id: string,
    text: string,
    images: { mediaType: string; data: string }[]
  ): void => {
    // A new turn: forget any stderr reason from a previous failed one, so a
    // fresh error is described by fresh diagnostics, not a stale line.
    lastStderrRef.current = null
    if (contextLostRef.current) {
      contextLostRef.current = false
      const recap = buildRecap()
      if (recap) {
        text =
          '[The earlier session for this conversation was lost, so you have no memory of ' +
          'it. Here is a recap of what was said before — treat it as the conversation so ' +
          'far and continue from it.]\n\n' +
          recap +
          '\n\n---\n\n' +
          text
      }
    }
    window.cove.agentSend(id, text, images)
  }

  // The agent's lifecycle must not be tied to this callback's identity: the effect
  // below stops the claude process on teardown, so a re-created handleEvent (which
  // is what Fast Refresh hands us on every edit) would kill a generation mid-turn.
  const handleEventRef = useRef(handleEvent)
  useEffect(() => {
    handleEventRef.current = handleEvent
  }, [handleEvent])

  useEffect(() => {
    // Dormant: nothing to start. wake() clears the flag and bumps resetKey, which
    // re-runs this effect to do the actual spawn.
    if (suspendedRef.current) return
    let disposed = false
    let offEvent: (() => void) | undefined
    let offUser: (() => void) | undefined
    let offStderr: (() => void) | undefined
    let offExit: (() => void) | undefined
    let offResumeLost: (() => void) | undefined

    // No session id to resume but a real prior conversation already on screen →
    // this process starts blank under an existing exchange. That's the silent
    // context loss; arm a recap so the first message carries what came before.
    // Gate on a prior ASSISTANT reply, not just any message: a brand-new chat's
    // first send has already put the user message into the transcript by now, so
    // "some message exists" is true on every new chat — which falsely armed the
    // recap (and duplicated the message) on the most common path of all.
    if (
      !resumeIdRef.current &&
      itemsRef.current.some(
        (it) => it.kind === 'msg' && it.msg.role === 'assistant' && !it.msg.system
      )
    ) {
      contextLostRef.current = true
    }

    window.cove
      .agentStart({
        cwd,
        workspaceId,
        chatId,
        resumeSessionId: resumeIdRef.current,
        browserProject,
        permissionMode: useStore.getState().permissionMode,
        model: useStore.getState().model
      })
      .then((id) => {
        if (disposed) {
          window.cove.agentStop(id)
          return
        }
        agentIdRef.current = id
        registerAgent(workspaceId, id)
        // Ready as soon as the process is up — in stream-json input mode claude
        // waits for the first user message before it emits anything.
        setReady(true)
        // Anything sent while there was no process goes out now (the first of
        // them carries the recap if this session came up without its memory).
        for (const q of pendingSendsRef.current.splice(0)) sendToAgent(id, q.text, q.images)
        offEvent = window.cove.onAgentEvent(id, (e) => handleEventRef.current(e))
        // A prompt typed on the paired phone: show it here too, and treat the
        // turn as ours to render (generating/thinking, exactly like a local send).
        offUser = window.cove.onAgentUser?.(id, ({ text }) => {
          setItems((prev) => [
            ...prev,
            {
              kind: 'msg',
              msg: { id: `u-${Date.now()}-${Math.random()}`, at: Date.now(), role: 'user', text }
            }
          ])
          setGenerating(true)
          setThinking(true)
        })
        // Keep the CLI's real diagnostic around so a failed turn can quote it
        // instead of the generic note (see the result handler).
        offStderr = window.cove.onAgentStderr?.(id, (chunk) => {
          const line = meaningfulStderr(chunk)
          if (line) lastStderrRef.current = line
        })
        // main only emits agent:exit on a genuine unexpected exit (deliberate
        // stops and the resume→fresh retry are suppressed), so surface it.
        const died = (reason?: string): void => {
          setReady(false)
          setGenerating(false)
          setThinking(false)
          setRunningAgents([])
          setAgentFailed(reason === 'missing-cwd' ? 'missing-cwd' : true)
        }
        // Resuming failed and a fresh session took its place: arm the recap so
        // the next message carries the conversation, and say so plainly (a recap
        // is not the same as Claude actually remembering).
        const resumeLost = (): void => {
          if (disposed) return
          contextLostRef.current = true
          setItems((prev) =>
            // Guard against a double notice (event + catch-up both firing).
            prev.some((it) => it.kind === 'msg' && it.msg.id.startsWith('sys-resume-'))
              ? prev
              : [
                  ...prev,
                  {
                    kind: 'msg',
                    msg: {
                      id: `sys-resume-${Date.now()}`,
                      at: Date.now(),
                      role: 'assistant',
                      text:
                        '⚠ The earlier session could not be resumed, so this one starts fresh. ' +
                        'Your next message includes a short recap of the conversation above so ' +
                        'Claude can keep going — but details beyond that recap are gone.',
                      system: true
                    }
                  }
                ]
          )
        }
        offResumeLost = window.cove.onAgentResumeLost?.(id, resumeLost)
        offExit = window.cove.onAgentExit(id, () => {
          // The exit event carries no reason; main still knows one.
          void window.cove.agentDied?.(id).then((d) => died(d?.reason))
        })
        // A spawn failure — or a resume that was lost — can land before these
        // subscriptions exist. Ask whether we already missed either, or the chat
        // sits on "Working"/context-blind with no notice.
        void window.cove.agentDied?.(id).then((d) => {
          if (!disposed && d) died(d.reason)
        })
        void window.cove.agentResumeLostCheck?.(id).then((lost) => {
          if (!disposed && lost) resumeLost()
        })
      })

    return () => {
      disposed = true
      offResumeLost?.()
      offEvent?.()
      offUser?.()
      offStderr?.()
      offExit?.()
      if (agentIdRef.current) window.cove.agentStop(agentIdRef.current)
    }
    // model + permissionMode are dependencies on purpose: changing either must
    // restart the agent (resuming the same session, so context is kept) or the
    // picker silently does nothing to the conversation you are in.
  }, [cwd, workspaceId, chatId, registerAgent, resetKey, browserProject, model, permissionMode])

  const wake = useCallback((): void => {
    if (!suspendedRef.current) return
    suspendedRef.current = false
    setSuspended(false)
    setResetKey((k) => k + 1)
  }, [])

  // Every workspace you visit stays mounted for the life of the app, and each
  // mounted chat holds a `claude -p` that idles on stdin forever — nothing ever
  // reclaims it. Left alone that's one resident process (and its ~150MB) per
  // project you so much as clicked on, which is how a long-running app ends up
  // with a dozen idle agents and a full swap file. So reap the process once a
  // backgrounded chat has sat idle: the transcript is React state and the session
  // id is persisted, so coming back is a --resume away.
  useEffect(() => {
    // Never reap a chat that has live background work (a Monitor, a long poll, a
    // running server the agent backgrounded). Reaping kills the claude process,
    // and those jobs are its children — so an unseen monitoring session used to
    // die 5 minutes after you switched away to work elsewhere. Its own work
    // keeps it resident; the reaper re-arms once the background pills clear.
    if (visible || suspended || generating || thinking || bgTasks.length > 0) return
    const timer = window.setTimeout(() => {
      const id = agentIdRef.current
      if (!id) return
      window.cove.agentStop(id)
      agentIdRef.current = null
      setReady(false)
      suspendedRef.current = true
      setSuspended(true)
      // The reaped process is the only thing that could ever poll a backgrounded
      // shell to "done", so its pills can never clear on their own now. Drop them
      // — otherwise busy.background stays > 0, which pins this chat mounted for
      // the life of the app with a pill stuck on "running" forever.
      setBgTasks([])
    }, IDLE_REAP_MS)
    return () => window.clearTimeout(timer)
  }, [visible, suspended, generating, thinking, bgTasks.length])

  // Actually stop a background job. The app has no direct handle to a job the
  // agent backgrounded (a `&` job has none at all; a run_in_background one is a
  // shell only the agent's KillShell can reach), so we ask the agent to kill it —
  // it started it and can. Drops the pill either way; if the session is already
  // gone the job died with it. (The reliable, agent-free version is task #59.)
  const stopBgTask = (t: BackgroundTask): void => {
    setControlMenu(null)
    setBgTasks((cur) => cur.filter((x) => x.toolUseId !== t.toolUseId))
    const id = agentIdRef.current
    if (!id) return // session gone → the job died with it; just cleared the pill
    const instruction = t.shellId
      ? `Stop the background job you started earlier (shell ${t.shellId}): \`${t.command}\`. ` +
        `Kill it with KillShell, then confirm in one short line that it's stopped.`
      : `Stop the background job you started earlier: \`${t.command}\`. Find its process and ` +
        `kill it (pkill/kill), then confirm in one short line that it's stopped.`
    // Show a clean line in the chat so it's clear this was sent (the agent gets
    // the detailed instruction above).
    setItems((prev) => [
      ...prev,
      {
        kind: 'msg',
        msg: {
          id: `u-stop-${Date.now()}`,
          at: Date.now(),
          role: 'assistant',
          text: `⏹ Stopping background job: ${t.description || bgLabel(t.command)}`,
          system: true
        }
      }
    ])
    window.cove.agentSend(id, instruction, [])
    setGenerating(true)
    setThinking(true)
  }

  /**
   * A turn that finished while you were elsewhere leaves something to read.
   *
   * "Elsewhere" is either another conversation or another app — a reply that
   * lands while you are watching it arrive is not unread. The notification
   * already tells you it finished; this is what is still true tomorrow morning.
   */
  const markUnread = useStore((s) => s.markUnread)
  const markRead = useStore((s) => s.markRead)
  const wasWorking = useRef(false)
  useEffect(() => {
    const working = generating || thinking
    if (wasWorking.current && !working) {
      if (!visible || !document.hasFocus()) markUnread(chatId)
    }
    wasWorking.current = working
  }, [generating, thinking, visible, chatId, markUnread])
  // Looking at it is reading it — including coming back to the window.
  useEffect(() => {
    if (!visible) return
    const clear = (): void => {
      if (document.hasFocus()) markRead(chatId)
    }
    clear()
    window.addEventListener('focus', clear)
    return () => window.removeEventListener('focus', clear)
  }, [visible, chatId, markRead])

  // Publish what this chat has in flight, so an app-wide action (installing an
  // update quits the app, which kills every agent) can warn before discarding it.
  const setBusy = useStore((s) => s.setBusy)
  const clearBusy = useStore((s) => s.clearBusy)
  useEffect(() => {
    bgTasksRef.current = bgTasks
    setBusy(chatId, { generating: generating || thinking, background: bgTasks.length })
  }, [chatId, generating, thinking, bgTasks.length, setBusy])
  useEffect(() => () => clearBusy(chatId), [chatId, clearBusy])

  // Interval /loop: fire the prompt every N ms while idle (skip a tick if a turn
  // is still running, so runs don't pile up). Keyed on interval+prompt only, so
  // the per-run count bump doesn't restart the timer. Continuous loops (null
  // interval) re-fire from the turn-end handler instead, not here.
  const loopIntervalMs = loop?.intervalMs ?? null
  const loopPrompt = loop?.prompt ?? ''
  useEffect(() => {
    if (loopIntervalMs === null || !loopPrompt) return
    const iv = setInterval(() => {
      const lp = loopRef.current
      if (!lp || turnInFlightRef.current) return
      if (lp.count >= LOOP_CAP) {
        stopLoop()
        return
      }
      loopRef.current = { ...lp, count: lp.count + 1 }
      setLoop(loopRef.current)
      submitRef.current?.(loopPrompt)
    }, loopIntervalMs)
    return () => clearInterval(iv)
  }, [loopIntervalMs, loopPrompt, stopLoop])
  // Stop any loop when the chat unmounts, so a re-fire never lands in a torn-down chat.
  useEffect(() => () => stopLoop(), [stopLoop])

  // Drives the sidebar dot: full while this project has a live claude process,
  // half once it doesn't (reaped while idle, or torn down when the chat closes).
  const setAgentLive = useStore((s) => s.setAgentLive)
  useEffect(() => {
    setAgentLive(workspaceId, chatId, ready && !suspended)
  }, [workspaceId, chatId, ready, suspended, setAgentLive])
  useEffect(
    () => () => setAgentLive(workspaceId, chatId, false),
    [workspaceId, chatId, setAgentLive]
  )

  // Auto-scroll only when the user is already near the bottom, so scrolling up
  // to read scrollback isn't interrupted. Coalesced onto rAF: reading
  // scrollHeight right after React commits forces a synchronous reflow of the
  // whole transcript, and doing that per stream-flush doubled the layout work —
  // one scroll per painted frame is all a human can see anyway. Skipped
  // entirely for background (hidden) chats, where scrolling a display:none
  // transcript is pure waste.
  const scrollRafRef = useRef<number | null>(null)
  useEffect(() => {
    if (!atBottom || !visible) return
    if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
    })
    return () => {
      if (scrollRafRef.current !== null) {
        cancelAnimationFrame(scrollRafRef.current)
        scrollRafRef.current = null
      }
    }
  }, [items, thinking, atBottom, visible])

  // Track the composer's width so the placeholder can shed its hints before
  // they wrap. Observing the textarea itself keeps this correct under both
  // window resizes and the draggable chat/browser split.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0
      setNarrowComposer(w > 0 && w < 400)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    setAtBottom(near)
  }

  const scrollToBottom = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    setAtBottom(true)
  }

  // Cleared from the sidebar menu: drop everything and go dormant — the next
  // message starts a fresh session with no carried context.
  useEffect(() => {
    const onCleared = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { chatId: string }
      if (detail.chatId !== chatId) return
      if (agentIdRef.current) {
        window.cove.agentStop(agentIdRef.current)
        agentIdRef.current = null
      }
      stopLoop()
      setItems([])
      tasks.current.clear()
      useStore.getState().clearTodos(chatId)
      resumeIdRef.current = null
      setReady(false)
      suspendedRef.current = true
      setSuspended(true)
    }
    window.addEventListener('cove:chat-cleared', onCleared)
    return () => window.removeEventListener('cove:chat-cleared', onCleared)
  }, [chatId, workspaceId])

  // Messages injected from toolbar actions (e.g. the Skills panel) in Easy mode.
  useEffect(() => {
    const onInjected = (e: Event): void => {
      const detail = (e as CustomEvent).detail as { workspaceId: string; text: string }
      if (detail.workspaceId !== workspaceId || !visible) return
      // The chat owns its agent process — and may have reaped it while it sat in
      // the background — so delivery happens here rather than through a cached id.
      if (agentIdRef.current) window.cove.agentSend(agentIdRef.current, detail.text)
      else {
        pendingSendsRef.current.push({ text: detail.text, images: [] })
        wake()
      }
      setItems((prev) => [
        ...prev,
        {
          kind: 'msg',
          msg: { id: `u-${Date.now()}`, at: Date.now(), role: 'user', text: detail.text }
        }
      ])
      setThinking(true)
      setGenerating(true)
    }
    window.addEventListener('cove:easy-user-message', onInjected)
    return () => window.removeEventListener('cove:easy-user-message', onInjected)
  }, [workspaceId, wake, visible])

  const submitRef = useRef<((t: string) => void) | null>(null)

  const submit = (text: string, images: PendingImage[] = []): void => {
    const id = agentIdRef.current
    const files = pendingFiles
    if (!text && images.length === 0 && files.length === 0) return
    // A process exists but isn't accepting (crash) — the Retry UI owns that.
    if (id && !ready) return
    if (!id && !suspendedRef.current) return // already spawning; drop rather than double-send
    // /loop — Superagent's in-chat loop, like the terminal: re-run this prompt in
    // this conversation until you stop. Intercept it here so the literal command
    // is never sent to Claude as a message.
    const loopCmd = /^\/loop(\s|$)/i.test(text.trim()) ? parseLoopCmd(text) : null
    if (loopCmd !== null) {
      const sys = (t: string): void =>
        setItems((prev) => [
          ...prev,
          {
            kind: 'msg',
            msg: {
              id: `sys-${Date.now()}`,
              at: Date.now(),
              role: 'assistant',
              text: t,
              system: true
            }
          }
        ])
      if (/^\/loop\s+stop\s*$/i.test(text.trim())) {
        stopLoop()
        sys('⏹ Loop stopped.')
        setInput('')
        return
      }
      if (!loopCmd.prompt) {
        sys(
          'Usage: /loop [5m·2h·…] <prompt> — repeats the prompt in this chat until you Stop it. `/loop stop` ends it.'
        )
        return
      }
      const { prompt, intervalMs } = loopCmd
      loopRef.current = { prompt, intervalMs, count: 1 }
      setLoop(loopRef.current)
      sys(
        intervalMs
          ? `🔁 Looping every ${humanInterval(intervalMs)}: “${prompt}”. Stop anytime.`
          : `🔁 Looping: “${prompt}” — re-runs when each turn finishes. Stop anytime.`
      )
      setInput('')
      // Kick off the first iteration now.
      submit(prompt)
      return
    }
    // Sent while a turn is already running — this is a mid-task interjection.
    // Read the ref, not `generating`: two messages fired in the same tick would
    // both see the stale state and race. Mark a turn in flight right now so the
    // next one this tick is correctly treated as an interjection.
    const interjecting = turnInFlightRef.current
    turnInFlightRef.current = true
    const reply = replyTarget
    setReplyTarget(null)
    // Name an untitled chat after its opening message, so the sidebar list is
    // scannable without the user having to name anything.
    if (text.trim() && items.length === 0) {
      // Provisional, so the sidebar isn't blank while the turn runs; the agent
      // replaces it with a real summary once it has something to summarize.
      const title = text.trim().replace(/\s+/g, ' ').slice(0, 60)
      placeholderTitleRef.current = title
      aiTitledRef.current = false
      window.cove.chatUpdate(chatId, { title })
      useStore.getState().touchChat(workspaceId, chatId, { title })
    }
    // Show the message and clear the composer right away.
    setItems((prev) => [
      ...prev,
      {
        kind: 'msg',
        msg: {
          id: `u-${Date.now()}-${Math.random()}`,
          at: Date.now(),
          role: 'user',
          text: files.length
            ? `${text}${text ? '\n' : ''}📎 ${files.map((f) => f.name).join(' · ')}`
            : text,
          images: images.length ? images.map((im) => im.url) : undefined,
          replyTo: reply ?? undefined
        }
      }
    ])
    setInput('')
    setPendingImages([])
    setPendingFiles([])
    if (inputRef.current) inputRef.current.style.height = 'auto'
    // Quote the replied-to message so the agent knows what you're responding to.
    let agentText = reply
      ? `> Replying to ${reply.role === 'user' ? 'my' : 'your'} earlier message:\n> "${reply.text.replace(/\s+/g, ' ').trim().slice(0, 400)}"\n\n${text}`
      : text
    if (files.length > 0) {
      // Chips travel as explicit file references the agent can read.
      agentText = `${agentText}${agentText ? '\n\n' : ''}Attached files:\n${files
        .map((f) => f.path)
        .join('\n')}`
    }
    // Forward every message to Claude the instant you send it — even mid-turn. It
    // reaches Claude's stdin while it's working (verified), but Claude can still
    // deprioritize a bare interjection when it's mid-task. Flag it explicitly so it
    // stops at the next step, takes the new instruction into account, and doesn't
    // just barrel on to finish what it was doing. Only the wrapper is sent — the
    // chat still shows your clean message.
    if (interjecting && text.trim()) {
      agentText =
        '[The user sent this WHILE you are still working on the previous request. ' +
        'Treat it as a course-correction: pause at the next safe point, re-read it, and ' +
        'act on it now rather than finishing the earlier plan unchanged. If it changes ' +
        'what you should do, adjust; if it reorders priorities, follow the new order.]\n\n' +
        agentText
    }
    // Only reset the "did this turn produce anything" flag when starting a fresh
    // turn — a mid-turn interjection is part of the turn already in progress.
    if (!interjecting) streamedThisTurnRef.current = false
    // Clear stale sub-agent pills at the START of a fresh turn, not the end of the
    // last one: the agent can leave builders/sub-agents running past a turn (it
    // says so — "running now, I'll pick up as each finishes"), and sweeping them
    // when the turn ended hid genuinely-running work. They persist now until you
    // send the next message.
    if (!interjecting) setRunningAgents([])
    const payload = images.map((im) => ({ mediaType: im.mediaType, data: im.data }))
    if (!interjecting) {
      inFlightSendRef.current = { text: agentText, images: payload }
      retriedEmptyTurnRef.current = false
    }
    if (id) {
      sendToAgent(id, agentText, payload)
    } else {
      // First message of a dormant chat: this is the moment the session starts.
      pendingSendsRef.current.push({ text: agentText, images: payload })
      wake()
    }
    setThinking(true)
    setGenerating(true)
  }

  /**
   * Stop what the agent is doing right now — even inside a long tool call —
   * and pick up from the same session. Sending to stdin only reaches Claude
   * between steps, so a message during a 15-minute deploy waited for the
   * deploy; this signals the process instead and resumes with --resume, so
   * nothing about the conversation is lost.
   */
  const interruptNow = useCallback(
    async (thenSend?: {
      text: string
      images: { mediaType: string; data: string }[]
    }): Promise<void> => {
      const id = agentIdRef.current
      if (!id) return
      interruptedRef.current = true
      setThinking(false)
      setGenerating(false)
      setRunningAgents([])
      await window.cove.agentHardInterrupt?.(id)
      agentIdRef.current = null
      setReady(false)
      setItems((prev) => [
        ...prev,
        {
          kind: 'msg',
          msg: {
            id: `sys-${Date.now()}`,
            at: Date.now(),
            role: 'assistant',
            text: thenSend ? '⏹ Interrupted — picking up your message.' : '⏹ Interrupted.',
            system: true
          }
        }
      ])
      if (thenSend) pendingSendsRef.current.push(thenSend)
      // Respawn against the same session; queued sends flush once it's up.
      suspendedRef.current = true
      setSuspended(true)
      wake()
      if (thenSend) {
        setThinking(true)
        setGenerating(true)
      }
    },
    [wake]
  )

  const send = (): void => submit(input.trim(), pendingImages)
  submitRef.current = (t: string) => submit(t)

  const beginReply = (msg: ChatMessage): void => {
    setReplyTarget({ role: msg.role, text: msg.text })
    inputRef.current?.focus()
  }

  // Edit your last message (e.g. after Stop): put it back in the composer and drop
  // it — and anything after it — from the transcript, so you can fix it and resend.
  const editMessage = (msg: ChatMessage): void => {
    setInput(msg.text)
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.kind === 'msg' && it.msg.id === msg.id)
      return idx >= 0 ? prev.slice(0, idx) : prev
    })
    requestAnimationFrame(() => {
      autoResize()
      inputRef.current?.focus()
    })
  }

  // The most recent user message — it gets an Edit affordance when idle.
  let lastUserId: string | null = null
  for (let k = items.length - 1; k >= 0; k--) {
    const it = items[k]
    if (it.kind === 'msg' && it.msg.role === 'user') {
      lastUserId = it.msg.id
      break
    }
  }
  // Two-finger trackpad swipe-right on a message to reply to it (like WhatsApp).
  // A wheel gesture — not a click-drag — so it never fights text selection. The
  // gesture has no "end" event, so a short quiet timer snaps the bubble back.
  const onMsgWheel = (e: React.WheelEvent<HTMLDivElement>, msg: ChatMessage): void => {
    // Ignore vertical scroll; only act on clearly horizontal swipes.
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    const el = e.currentTarget
    let s = swipeRef.current
    if (!s || s.el !== el) {
      s = { dx: 0, fired: false, el }
      swipeRef.current = s
    }
    // Natural scrolling reports fingers-moving-right as negative deltaX; mirror
    // that as the bubble sliding right.
    s.dx += -e.deltaX
    const slide = Math.max(0, Math.min(s.dx, 72))
    el.style.transition = 'none'
    el.style.transform = `translateX(${slide}px)`
    if (!s.fired && s.dx > 44) {
      s.fired = true
      beginReply(msg)
    }
    if (swipeTimer.current) clearTimeout(swipeTimer.current)
    swipeTimer.current = window.setTimeout(() => {
      el.style.transition = ''
      el.style.transform = ''
      swipeRef.current = null
      swipeTimer.current = null
    }, 140)
  }

  const stop = (): void => {
    void interruptNow()
  }

  // STABLE row handlers: MessageRow is memoized, and a fresh arrow prop per
  // render would defeat that. The identities below never change; they read the
  // live closures through a ref updated each render-commit.
  const rowFnsRef = useRef({ onMsgWheel, beginReply, editMessage, submit, setLightbox })
  useEffect(() => {
    rowFnsRef.current = { onMsgWheel, beginReply, editMessage, submit, setLightbox }
  })
  const onRowWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>, m: ChatMessage) => rowFnsRef.current.onMsgWheel(e, m),
    []
  )
  const onRowReply = useCallback((m: ChatMessage) => rowFnsRef.current.beginReply(m), [])
  const onRowEdit = useCallback((m: ChatMessage) => rowFnsRef.current.editMessage(m), [])
  const onRowAnswer = useCallback((a: string) => rowFnsRef.current.submit(a), [])
  const onRowLightbox = useCallback((src: string) => rowFnsRef.current.setLightbox(src), [])
  // The transcript rows, recomputed only when the items actually change — not on
  // every keystroke/timer render of the surrounding component.
  const rows = useMemo(() => toRows(items), [items])

  /** When the mic went down, and whether this is a hands-free (tapped) session. */
  const micDownAtRef = useRef(0)
  const handsFreeRef = useRef(false)
  const lastMicKeyRef = useRef(0)

  const startDictation = useCallback((): void => {
    if (dictation.state !== 'idle') return
    void dictation.start()
  }, [dictation])

  // Insert at the caret rather than appending, so you can dictate into the
  // middle of something you already typed.
  const finishDictation = useCallback((): void => {
    if (dictation.state !== 'recording') return
    void dictation.stop().then((text) => {
      if (!text) return
      const el = inputRef.current
      const at = el ? (el.selectionStart ?? el.value.length) : input.length
      setInput((prev) => {
        const before = prev.slice(0, at)
        const after = prev.slice(at)
        const spacer = before && !/\s$/.test(before) ? ' ' : ''
        return before + spacer + text + after
      })
      el?.focus()
    })
  }, [dictation, input.length])

  // The window going away mid-hold means no keyup and no pointerup is ever
  // coming: transcribe what we have rather than recording into the void.
  useEffect(() => {
    if (!visible) return
    const onBlur = (): void => {
      if (dictation.state === 'recording') finishDictation()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [dictation.state, finishDictation, visible])

  // Hold ⌥Space to dictate from anywhere in the window; release to transcribe.
  // Only the on-screen chat listens — a hidden busy sibling must not grab the mic.
  useEffect(() => {
    if (!visible) return
    const down = (e: KeyboardEvent): void => {
      if (e.altKey && e.code === 'Space' && !e.repeat) {
        const now = Date.now()
        // Double-tap = hands-free, so a long dictation doesn't mean a long hold.
        if (now - lastMicKeyRef.current < 400) handsFreeRef.current = true
        else handsFreeRef.current = false
        lastMicKeyRef.current = now
        e.preventDefault()
        startDictation()
      }
    }
    const up = (e: KeyboardEvent): void => {
      // Releasing either key ends the gesture — holding ⌥ and letting go of
      // Space (or vice versa) should both stop, not leave the mic open.
      if ((e.code === 'Space' || e.key === 'Alt') && !handsFreeRef.current) finishDictation()
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [startDictation, finishDictation, visible])

  // Adds a sibling conversation rather than wiping this one — the previous chat
  // keeps its transcript and stays resumable from the sidebar.
  const newChat = (): void => {
    setInput('')
    setPendingImages([])
    setMentionQuery(null)
    tasks.current.clear()
    // No clearTodos here: todos are per-chat now, so the new chat already starts
    // empty and the previous one keeps its list along with its transcript.
    useStore.getState().newChat(workspaceId)
  }

  // Restart the agent after an unexpected exit — keeps the conversation. Resumes
  // the session, but if a resume-retry already failed, start fresh so a stale
  // session lock can't loop the Retry button.
  const retry = (): void => {
    setAgentFailed(false)
    setReady(false)
    if (resumeRetriedRef.current && resumeIdRef.current) {
      resumeIdRef.current = null
      window.cove.chatUpdate(chatId, { claudeSessionId: null })
    }
    resumeRetriedRef.current = true
    setResetKey((k) => k + 1)
  }

  // Apply a new model or mode: persist it, then respawn the agent (resuming this
  // conversation) so the flag takes effect now. Stops any in-flight turn first.
  const applyRespawn = (): void => {
    setControlMenu(null)
    if (agentIdRef.current) window.cove.agentInterrupt(agentIdRef.current)
    setReady(false)
    setGenerating(false)
    setThinking(false)
    setResetKey((k) => k + 1)
  }
  const pickModel = (value: string): void => {
    if (value !== model) setModel(value)
    applyRespawn()
  }
  const pickMode = (value: PermissionMode): void => {
    if (value !== permissionMode) setPermissionMode(value)
    applyRespawn()
  }
  const modelLabel = MODEL_OPTIONS.find((m) => m.value === model)?.label ?? 'Default'
  /**
   * How much of Claude's memory this conversation fills. The window depends on
   * the model running — read from the id it reports at startup.
   *
   * Opus 5 and Fable 5 are 1M-context models whether or not the id carries the
   * [1m] tag: sessions were measured running with far more than 200K tokens in
   * them (376K on Opus, 846K on Fable), which cannot fit a 200K window and still
   * run — so plain claude-opus-5 / claude-fable-5 were under-reported as 200K and
   * the gauge sat pinned at 100% on a conversation using a fraction of its room.
   * The [1m] tag still forces 1M for the models that offer it as a choice
   * (Sonnet), and everything else is the 200K baseline.
   */
  const ctxWindow =
    activeModel && (/\[1m\]/i.test(activeModel) || /opus-?5|opus\b|fable/i.test(activeModel))
      ? 1_000_000
      : 200_000
  const ctxPercent = Math.min(100, Math.round(((ctxTokens ?? 0) / ctxWindow) * 100))
  const modeLabel = MODE_OPTIONS.find((m) => m.value === permissionMode)?.label ?? 'Full'

  return (
    <div
      ref={chatRef}
      className={`easy-chat ${dragOver ? 'drag-over' : ''} ${narrowComposer ? 'narrow' : ''}`}
      onDragOver={(e) => {
        // Allow the drop (default would block it); the window effect shows the hint.
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={onDrop}
    >
      {dragOver && <div className="easy-drop-hint">Drop a file to add it</div>}
      {agentFailed && (
        <div className="easy-error">
          <span>
            {agentFailed === 'missing-cwd' ? (
              <>
                ⚠ This project&rsquo;s folder isn&rsquo;t there any more — it was moved or deleted.
              </>
            ) : (
              <>⚠ Claude stopped. Make sure Claude Code is installed and you&rsquo;re signed in.</>
            )}
          </span>
          <button onClick={retry}>Retry</button>
        </div>
      )}
      {/* The tasks/dev-server strip stays in normal flow — floating the pills
          over it is the old bug. The pills themselves live inside the
          transcript below, pinned to its top, so they float over the messages
          and nothing else. */}
      <div className="easy-topstack">
        {loop && (
          <div className="easy-loop-bar">
            <span className="easy-loop-spin" />
            <span className="easy-loop-text">
              Looping{loop.intervalMs ? ` every ${humanInterval(loop.intervalMs)}` : ''} · run{' '}
              {loop.count}
              <span className="easy-loop-prompt"> — “{loop.prompt}”</span>
            </span>
            <button className="easy-loop-stop" onClick={stopLoop}>
              Stop
            </button>
          </div>
        )}
        <TasksPanel chatId={chatId} />
      </div>
      <div className="easy-transcript">
        <div className="easy-scroll" ref={scrollRef} onScroll={onScroll}>
          {items.length > 0 && !hideNewChat && (
            <div className="easy-newchat-group">
              {/* This chat's changes live in its own copy of the project until
                  the user decides. Shown only when there IS something unkept. */}
              {isWorktreeChat && wtChanges && (
                <>
                  <button
                    className="easy-newchat easy-keep"
                    data-tip="Adds everything this chat changed to the project as one change, named after the chat, then closes the chat. Your other chats and your checkout aren't touched."
                    onClick={() =>
                      window.cove.chatKeepRequest({
                        chatId,
                        workspaceId,
                        projectPath: cwd.split('/.worktrees/')[0],
                        wtPath: cwd
                      })
                    }
                  >
                    ✓ Keep
                  </button>
                  <button
                    className="easy-newchat easy-throw"
                    data-tip="Deletes everything this chat changed — its branch and its working copy. Can't be undone."
                    onClick={() => window.cove.chatThrowRequest({ chatId, workspaceId })}
                  >
                    Throw away
                  </button>
                </>
              )}
              <button
                className="easy-newchat"
                onClick={newChat}
                data-tip="Starts a new conversation. On a git project it gets its own copy of the project."
              >
                ✎ New chat
              </button>
              {/* One button. A new chat on a repo IS its own checkout now (the
                  store isolates it automatically), so the separate ⎇ New
                  worktree pill and its branch picker are gone. */}
            </div>
          )}
          {items.length === 0 && (ready || suspended) && (
            <div className="easy-empty">
              <p>Tell Claude what you&rsquo;d like to build or change.</p>
            </div>
          )}
          {items.length === 0 && !ready && !suspended && !agentFailed && (
            <div className="easy-empty">Starting Claude…</div>
          )}
          {rows.map((row) => {
            if (row.kind === 'msg') {
              const isLastUser = row.msg.role === 'user' && row.msg.id === lastUserId
              return (
                <MessageRow
                  key={row.msg.id}
                  msg={row.msg}
                  showEdit={isLastUser && !generating}
                  onWheelMsg={onRowWheel}
                  onReply={onRowReply}
                  onEdit={onRowEdit}
                  onAnswer={onRowAnswer}
                  onLightbox={onRowLightbox}
                />
              )
            }
            if (row.kind === 'thinking') {
              if (!row.text) return null
              return (
                <div key={row.id} className="easy-thought">
                  {row.text}
                </div>
              )
            }
            // Activity rows keyed by their first entry's tool/diff id — stable as
            // rows shift, unlike the array index (index keys remounted every later
            // message whenever a strip was inserted mid-turn, blowing the Markdown
            // memo cache exactly when tools were streaming).
            const first = row.entries[0]
            const actKey = 'act-' + (first.kind === 'tool' ? first.tool.id : first.diff.id)
            return <ActivityStrip key={actKey} entries={row.entries} />
          })}
          {generating && (
            <div className="easy-thinking">
              {/* The brand mark, thinking: a light dot orbiting inside the black
                  tile — the app's own icon, in motion. */}
              <span className="easy-think-mark" aria-hidden="true">
                <span className="easy-think-dot" />
              </span>
              <WorkingTimer />
            </div>
          )}
        </div>
        {!atBottom && items.length > 0 && (
          <button className="easy-scrolldown" onClick={scrollToBottom} title="Scroll to bottom">
            ↓
          </button>
        )}
      </div>
      {dictation.error && (
        <div className="easy-dictation-error" role="status">
          Dictation failed: {dictation.error}
        </div>
      )}
      {/* Pending attachments sit in their own row above the composer, in normal
          flow so they reserve space — they used to float over the transcript and
          cover the last messages. */}
      {(pendingFiles.length > 0 || pendingImages.length > 0) && (
        <div className="easy-attachments">
          {pendingFiles.map((f, idx) => (
            <div key={f.path} className="easy-file-chip" title={f.path}>
              <span className="easy-file-chip-icon">📄</span>
              <span className="easy-file-chip-name">{f.name}</span>
              <button
                className="easy-attachment-remove"
                onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== idx))}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
          {pendingImages.map((img, idx) => (
            <div key={idx} className="easy-attachment">
              <img src={img.url} alt="pasted" />
              <button
                className="easy-attachment-remove"
                onClick={() => setPendingImages((prev) => prev.filter((_, i) => i !== idx))}
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="easy-input-row">
        {replyTarget && (
          <div className="easy-reply-bar">
            <span className="easy-reply-bar-icon">↩</span>
            <span className="easy-reply-bar-text">
              {replyTarget.text.replace(/\s+/g, ' ').trim().slice(0, 160)}
            </span>
            <button
              className="easy-reply-bar-cancel"
              title="Cancel reply"
              onClick={() => setReplyTarget(null)}
            >
              ×
            </button>
          </div>
        )}
        {mentionMatches.length > 0 && (
          <div className="easy-mention-menu">
            {mentionMatches.map((f, idx) => (
              <button
                key={f.text}
                className={`easy-mention-item ${idx === mentionIndex ? 'active' : ''}`}
                onMouseEnter={() => setMentionIndex(idx)}
                onClick={() => pickMention(f)}
              >
                {mentionKind === 'cmd' ? (
                  <>
                    <span className="easy-mention-name">/{f.text}</span>
                    {commandDescs[f.text] && (
                      <span className="easy-mention-desc">{commandDescs[f.text]}</span>
                    )}
                  </>
                ) : f.hint ? (
                  <>
                    <span className="easy-mention-name">{f.label}</span>
                    <span className="easy-mention-desc">{f.hint}</span>
                  </>
                ) : (
                  f.label
                )}
              </button>
            ))}
          </div>
        )}
        <div className="easy-input-box">
          <textarea
            ref={inputRef}
            className="easy-input"
            value={input}
            placeholder={
              ready || suspended
                ? narrowComposer
                  ? 'Message Claude…'
                  : 'Message Claude…  (/ commands · @ files · paste an image)'
                : 'Starting…'
            }
            rows={1}
            disabled={!ready && !suspended}
            onChange={(e) => {
              setInput(e.target.value)
              autoResize()
              updateMention(e.target.value)
            }}
            onKeyDown={(e) => {
              if (mentionMatches.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setMentionIndex((i) => (i + 1) % mentionMatches.length)
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length)
                  return
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault()
                  pickMention(mentionMatches[mentionIndex])
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  setMentionQuery(null)
                  return
                }
              }
              // Esc drops a recording first: if the mic is open that's what the
              // user means by "stop".
              if (e.key === 'Escape' && dictation.state === 'recording') {
                e.preventDefault()
                handsFreeRef.current = false
                dictation.cancel()
                return
              }
              // Esc stops the agent where it is — the terminal's Ctrl-C, and the
              // only thing that reaches it inside a long tool call.
              if (e.key === 'Escape' && (generating || thinking)) {
                e.preventDefault()
                void interruptNow()
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                // ⌘⏎ (or ⌥⏎) while it's working: stop what it's doing and take
                // this message now, instead of queueing it behind the current step.
                if ((e.metaKey || e.altKey) && (generating || thinking)) {
                  const text = input.trim()
                  if (text) {
                    setItems((prev) => [
                      ...prev,
                      {
                        kind: 'msg',
                        msg: { id: `u-${Date.now()}`, at: Date.now(), role: 'user', text }
                      }
                    ])
                    setInput('')
                    void interruptNow({ text, images: [] })
                    return
                  }
                }
                send()
              }
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              attachFiles([...(e.target.files ?? [])])
              e.target.value = '' // allow re-picking the same file
            }}
          />
          <button
            className={`easy-mic ${dictation.state === 'recording' ? 'recording' : ''}`}
            // Hold to talk, or tap for hands-free — the shape Wispr Flow settled
            // on, and the reason a stuck mic used to have no way out.
            onPointerDown={() => {
              if (dictation.state === 'recording') {
                finishDictation()
                return
              }
              micDownAtRef.current = Date.now()
              handsFreeRef.current = false
              startDictation()
            }}
            onPointerUp={() => {
              // A tap (rather than a hold) means "keep listening until I say stop".
              if (Date.now() - micDownAtRef.current < 350) {
                handsFreeRef.current = true
                return
              }
              finishDictation()
            }}
            disabled={dictation.state === 'transcribing' || dictation.state === 'loading-model'}
            title={micTitle}
            aria-label={micTitle}
          >
            {dictation.state === 'recording' ? (
              // Bars that move with your voice: the one affordance that answers
              // "is it hearing me?" without a word of explanation. Clicking
              // stops — the button is a toggle once it's listening.
              <span className="easy-mic-wave" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <i
                    key={i}
                    style={{
                      height: `${Math.min(
                        13,
                        3 + dictation.level * 22 * (i === 1 || i === 2 ? 1 : 0.6)
                      )}px`
                    }}
                  />
                ))}
              </span>
            ) : dictation.state === 'loading-model' || dictation.state === 'transcribing' ? (
              <span className="easy-mic-spin" />
            ) : (
              <MicIcon />
            )}
          </button>
        </div>
        {generating ? (
          <button className="easy-stop" onClick={stop} title="Stop generating">
            <span className="easy-stop-square" />
          </button>
        ) : (
          <button
            className="easy-send"
            onClick={send}
            disabled={
              (!ready && !suspended) ||
              (!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0)
            }
            title="Send message"
            aria-label="Send message"
          >
            ↑
          </button>
        )}
      </div>
      <div className="easy-controls">
        {/* Attach sits with the other secondary controls, not inside the text
            box: parked in there (either edge) it crowded the first line of
            every message and read as one more mic-like control. */}
        <div className="easy-control">
          <button
            className="easy-control-btn easy-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={!ready && !suspended}
            title="Attach a file or image"
            aria-label="Attach a file"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M21.44 11.05l-9.19 9.19a5 5 0 0 1-7.07-7.07l9.19-9.19a3.5 3.5 0 0 1 4.95 4.95l-9.2 9.19a1.5 1.5 0 0 1-2.12-2.12l8.49-8.49" />
            </svg>
            <span className="easy-control-val">Attach</span>
          </button>
        </div>
        <div className="easy-control">
          <button
            className={`easy-control-btn ${controlMenu === 'model' ? 'open' : ''}`}
            onClick={() => setControlMenu((m) => (m === 'model' ? null : 'model'))}
            title="Model"
          >
            <span className="easy-control-key">Model</span>
            <span className="easy-control-val">{modelLabel}</span>
            <svg className="easy-control-caret" width="8" height="8" viewBox="0 0 10 10">
              <path
                d="M2 3.5L5 6.5L8 3.5"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {controlMenu === 'model' && (
            <div className="easy-control-menu">
              {MODEL_OPTIONS.map((o) => (
                <button
                  key={o.value || 'default'}
                  className={`easy-control-item ${o.value === model ? 'on' : ''}`}
                  onClick={() => pickModel(o.value)}
                >
                  <span className="easy-control-item-label">{o.label}</span>
                  <span className="easy-control-item-hint">
                    {/* Naming the resolution here rather than on the pill: the
                        pill showing "Opus 5" while the menu said Default read
                        as though Opus had been picked. */}
                    {o.value === '' && activeModel
                      ? `${o.hint} — right now ${shortModel(activeModel)}`
                      : o.hint}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="easy-control">
          <button
            className={`easy-control-btn ${controlMenu === 'mode' ? 'open' : ''}`}
            onClick={() => setControlMenu((m) => (m === 'mode' ? null : 'mode'))}
            title="Agent permissions"
          >
            <span className="easy-control-key">Mode</span>
            <span className="easy-control-val">{modeLabel}</span>
            <svg className="easy-control-caret" width="8" height="8" viewBox="0 0 10 10">
              <path
                d="M2 3.5L5 6.5L8 3.5"
                stroke="currentColor"
                strokeWidth="1.4"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          {controlMenu === 'mode' && (
            <div className="easy-control-menu">
              {MODE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  className={`easy-control-item ${o.value === permissionMode ? 'on' : ''}`}
                  onClick={() => pickMode(o.value)}
                >
                  <span className="easy-control-item-label">{o.label}</span>
                  <span className="easy-control-item-hint">{o.hint}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <DevServerPill
          workspaceId={workspaceId}
          open={controlMenu === 'server'}
          onToggle={() => setControlMenu((m) => (m === 'server' ? null : 'server'))}
        />
        {ctxTokens !== null && (
          <span className={`easy-ctx ${ctxPercent >= 75 ? 'warm' : ''}`}>
            {/* Our own tooltip rather than title=""; the native one waits about
                a second and cannot show the numbers as numbers. */}
            <span className="easy-ctx-tip" role="tooltip">
              <b>
                {ctxTokens.toLocaleString()} of {ctxWindow.toLocaleString()} tokens
              </b>
              <span>
                {activeModel ? `${shortModel(activeModel)} · ` : ''}
                {ctxWindow >= 1_000_000 ? '1M context window' : '200K context window'}
              </span>
              <span>
                When it fills, older turns are summarised automatically — nothing is lost, but
                detail fades. /compact does it now, on your terms.
              </span>
            </span>
            <span className="easy-ctx-label">Memory</span>
            <span className="easy-ctx-track">
              <span className="easy-ctx-fill" style={{ width: `${Math.min(100, ctxPercent)}%` }} />
            </span>
            <span className="easy-ctx-pct">{ctxPercent}%</span>
            {/* The bar only ever reported the problem. Past three quarters it
                offers the fix too — /compact summarises the conversation and
                hands the room back, which is otherwise something you have to
                know to type. */}
            {ctxPercent >= 75 && (
              <button
                className="easy-ctx-compact"
                disabled={generating || thinking}
                title={
                  generating || thinking
                    ? 'Wait for Claude to finish, then compact'
                    : 'Summarise the conversation so far to free up memory (/compact)'
                }
                onClick={() => submitRef.current?.('/compact')}
              >
                Compact
              </button>
            )}
          </span>
        )}
      </div>
      {/* Running work lives on its own row under the controls, not crammed into
          the Model/Mode line where a handful of jobs would wrap and shove the
          memory gauge around. Background commands the agent left running, plus
          any live sub-agent. Only present when there's something running. */}
      {(() => {
        // A bare `sleep N` with no description is the agent's own wait/poll
        // plumbing, not work worth a pill each — a run of them just drowns out
        // the real jobs, so collapse those into ONE quiet pill. Anything with a
        // description (what the terminal shows) is meaningful and shows
        // individually, as do real jobs and sub-agents.
        const isBareWait = (t: BackgroundTask): boolean =>
          sleepDurationSec(t.command) != null && !t.description
        const waits = bgTasks.filter(isBareWait)
        const jobs = bgTasks.filter((t) => !isBareWait(t))
        if (jobs.length === 0 && waits.length === 0 && runningAgents.length === 0) return null
        const remainMs = waits.length
          ? Math.max(0, ...waits.map((t) => (t.expiresAt ?? now) - now))
          : 0
        const remainS = Math.ceil(remainMs / 1000)
        const remainLabel = remainS >= 60 ? `${Math.round(remainS / 60)}m` : `${remainS}s`
        const count = jobs.length + runningAgents.length + (waits.length ? 1 : 0)
        if (runsHidden) {
          return (
            <div className="easy-runs collapsed">
              <button
                className="easy-runs-toggle"
                onClick={toggleRuns}
                title="Show what's running in the background"
              >
                <span className="easy-runs-label-pulse" />
                {count} running in background
                <span className="easy-runs-toggle-hint">Show</span>
              </button>
            </div>
          )
        }
        return (
          <div className="easy-runs">
            <span className="easy-runs-label">
              <span className="easy-runs-label-pulse" />
              Running in background
            </span>
            {jobs.map((t) => {
              const key = `bg-${t.toolUseId}`
              // The agent's description is what the terminal shows and what a
              // person understands ("Research US indie lane"); else the command.
              const name = t.description || bgLabel(t.command)
              const age = Math.max(1, Math.round((now - t.startedAt) / 1000))
              return (
                <div className="easy-control" key={t.toolUseId}>
                  <button
                    className={`easy-control-btn easy-run-pill ${controlMenu === key ? 'open' : ''}`}
                    onClick={() => setControlMenu((m) => (m === key ? null : key))}
                    title={t.command}
                  >
                    <span className="easy-run-dot" />
                    <span className="easy-control-val">{name}</span>
                    <span className="easy-run-age-inline">
                      {age < 60 ? `${age}s` : `${Math.round(age / 60)}m`}
                    </span>
                  </button>
                  {controlMenu === key && (
                    <div className="easy-control-menu easy-run-menu">
                      {t.description && <div className="easy-run-desc">{t.description}</div>}
                      <div className="easy-run-head">
                        <code>{t.command}</code>
                        <span className="easy-run-age">
                          {Math.max(1, Math.round((now - t.startedAt) / 1000))}s
                        </span>
                      </div>
                      <pre className="easy-run-out">
                        {t.output?.trim() ||
                          (t.manual
                            ? 'Backgrounded with & — no shell handle to read its output.'
                            : 'Waiting for output…')}
                      </pre>
                      <button
                        className="easy-control-item easy-run-stop"
                        onClick={() => stopBgTask(t)}
                      >
                        <span className="easy-control-item-label">⏹ Stop it</span>
                        <span className="easy-control-item-hint">Ask the agent to kill it</span>
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
            {runningAgents.map((a) => (
              <div className="easy-control" key={a.toolUseId}>
                <span
                  className="easy-control-btn easy-run-agent"
                  title={`Sub-agent working · ${a.label} · ${Math.max(1, Math.round((now - a.startedAt) / 1000))}s`}
                >
                  <span className="status-spinner easy-run-agent-spin" />
                  <span className="easy-control-val">🤖 {a.label}</span>
                </span>
              </div>
            ))}
            {/* All the agent's wait timers, as one calm pill. Not a spinning
              "running" dot — it's deliberately idle time, not work. */}
            {waits.length > 0 && (
              <div className="easy-control">
                <span
                  className="easy-control-btn easy-run-wait"
                  title={
                    `${waits.length} wait timer${waits.length > 1 ? 's' : ''} the agent set` +
                    (remainMs > 0 ? ` · up to ${remainLabel} left` : '')
                  }
                >
                  <span className="easy-wait-dot" />
                  <span className="easy-control-val">
                    waiting{waits.length > 1 ? ` · ${waits.length}` : ''}
                  </span>
                  {remainMs > 0 && <span className="easy-run-age-inline">{remainLabel}</span>}
                </span>
              </div>
            )}
            {/* Put the whole strip away. Nothing is stopped or forgotten: it
                folds to one line with a count, and Show brings it back. */}
            <button
              className="easy-runs-clear"
              title="Hide this strip — nothing is stopped; it folds to a one-line count"
              onClick={toggleRuns}
            >
              Hide
            </button>
          </div>
        )
      })()}
      {lightbox && (
        <div className="easy-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="attachment" />
        </div>
      )}
    </div>
  )
}
