import { mapTool } from './translate'
import type { AgentStartOptions } from '../agent-backend'

/**
 * What an Antigravity tool call may do without asking, per permission mode.
 *
 * Headless `agy` cannot prompt: a tool that would ask in its terminal UI is
 * quietly refused instead, and nothing a hook says can talk it round — a hook's
 * "allow" does not lift that refusal (checked against agy 1.2.14). What a hook
 * can do is say no: a "deny" from its `PreToolUse` hook stops a call even when
 * the CLI itself would have run it.
 *
 * So the gate is built the only way round that works. Every session runs with
 * `--dangerously-skip-permissions`, which leaves agy refusing nothing, and
 * installs a hook (see sidecar.ts) that asks Superagent before every call.
 * Superagent decides here: it lets the call through, refuses it, or holds it
 * while the user answers on the Mac or the phone. That is how "Ask" gets a real
 * prompt and how "Plan" is enforced rather than requested.
 *
 * Because the hook is the whole gate, two things guard the gate itself: the hook
 * command refuses on its own when it cannot reach Superagent (sidecar.ts), and
 * the session stops a process that ran a gated tool the hook never saw
 * (`hookSawStep` below).
 *
 * The policy is pure, no I/O, so it can be tested as a table.
 */

export type AgyMode = NonNullable<AgentStartOptions['permissionMode']>

export type AgyVerdict = 'allow' | 'ask' | 'deny'

/** The MCP server name Superagent's own tools are registered under. */
export const COVE_MCP_SERVER = 'cove-browser'

/** Tools that only look: nothing on the machine changes when they run. */
const READ_ONLY = new Set([
  'view_file',
  'list_dir',
  'find_by_name',
  'grep_search',
  'search_web',
  'read_url_content',
  'read_resource',
  'list_resources',
  'list_permissions',
  'command_status',
  'ask_question',
  'wait',
  'wait_5_seconds',
  'finish'
])

/** Delegation and bookkeeping: the work a subagent does is judged call by call. */
const COORDINATION = new Set([
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'send_message',
  'manage_task',
  'manage_inbox'
])

const FILE_WRITES = new Set([
  'write_to_file',
  'replace_file_content',
  'multi_replace_file_content',
  'sed_file',
  'notebook_edit'
])

const COMMANDS = new Set(['run_command', 'send_command_input', 'notebook_execution'])

export type AgyToolKind = 'read' | 'own' | 'coordination' | 'edit' | 'command' | 'other'

export function classifyAgyTool(
  name: string,
  args: Record<string, unknown>,
  artifactDir?: string
): AgyToolKind {
  if (name === 'call_mcp_tool' && args.ServerName === COVE_MCP_SERVER) return 'own'
  // The agent's own notes — a plan, a task list — live in a folder Antigravity
  // keeps per conversation. Writing there changes nothing of the user's, and it
  // is exactly what plan mode exists to produce.
  if (FILE_WRITES.has(name) && artifactDir) {
    const target = typeof args.TargetFile === 'string' ? args.TargetFile : ''
    const dir = artifactDir.endsWith('/') ? artifactDir : `${artifactDir}/`
    if (target.startsWith(dir)) return 'own'
  }
  if (READ_ONLY.has(name)) return 'read'
  if (COORDINATION.has(name)) return 'coordination'
  if (FILE_WRITES.has(name)) return 'edit'
  if (COMMANDS.has(name)) return 'command'
  return 'other'
}

/**
 * The verdict for one call.
 *
 * Reading, delegating, and Superagent's own tools (the browser pane, the board,
 * the simulator) run in every mode — in plan mode above all, where reading a
 * page is the thing you most want. Past that the modes mean what they say:
 *
 *  - bypassPermissions: everything runs.
 *  - acceptEdits: edits run; commands and anything unrecognised ask.
 *  - ask: edits, commands and anything unrecognised ask.
 *  - plan: nothing that changes the machine runs at all.
 */
export function agyVerdict(
  mode: AgyMode | undefined,
  name: string,
  args: Record<string, unknown>,
  artifactDir?: string
): AgyVerdict {
  const kind = classifyAgyTool(name, args, artifactDir)
  if (kind === 'read' || kind === 'own' || kind === 'coordination') return 'allow'
  switch (mode) {
    case 'plan':
      return 'deny'
    case 'ask':
      return 'ask'
    case 'acceptEdits':
      return kind === 'edit' ? 'allow' : 'ask'
    case 'bypassPermissions':
    default:
      return 'allow'
  }
}

/** Narrow a query-string value to a mode; anything else is the default. */
export function toAgyMode(value: unknown): AgyMode {
  return value === 'ask' || value === 'acceptEdits' || value === 'plan'
    ? value
    : 'bypassPermissions'
}

/**
 * A hook payload's tool call, in the names the approval prompt and the
 * injection gate already know (`Bash` with a `command`, `Edit` with a
 * `file_path`). Null when the payload names no tool.
 */
export function agyToolCall(body: Record<string, unknown>): {
  raw: string
  args: Record<string, unknown>
  name: string
  input: Record<string, unknown>
  sessionId: string
  /** Where Antigravity keeps this conversation's own notes. */
  artifactDir: string
  /** The step this call is, as the stream will number it. */
  stepIdx: number | null
} | null {
  const call = body.toolCall as { name?: unknown; args?: unknown } | undefined
  if (!call || typeof call.name !== 'string' || !call.name) return null
  const args =
    call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>)
      : {}
  const mapped = mapTool(call.name, args)
  return {
    raw: call.name,
    args,
    name: mapped.name,
    input: mapped.input,
    sessionId: typeof body.conversationId === 'string' ? body.conversationId : '',
    artifactDir: typeof body.artifactDirectoryPath === 'string' ? body.artifactDirectoryPath : '',
    stepIdx: typeof body.stepIdx === 'number' ? body.stepIdx : null
  }
}

/**
 * Which steps the hook was asked about, per chat.
 *
 * The hook is the only thing standing between a narrower mode and a CLI told to
 * approve everything, so the session does not take it on trust: when a gated
 * tool finishes, the hook must have been asked about that very step. If a
 * version of agy stopped loading the hook, the first such tool to run is also
 * the last (session.ts ends the process).
 */
const hookSteps = new Map<string, Set<number>>()

export function noteHookCall(key: string, stepIdx: number | null): void {
  if (!key || stepIdx === null) return
  let seen = hookSteps.get(key)
  if (!seen) hookSteps.set(key, (seen = new Set()))
  seen.add(stepIdx)
}

export function hookSawStep(key: string, stepIdx: number): boolean {
  return hookSteps.get(key)?.has(stepIdx) ?? false
}

export function forgetHookCalls(key: string): void {
  hookSteps.delete(key)
}

/**
 * Whether a finished tool step should have been put to the hook first: anything
 * the mode would not simply have waved through.
 */
export function needsHook(
  mode: AgyMode | undefined,
  name: string,
  args: Record<string, unknown>
): boolean {
  return (
    (mode ?? 'bypassPermissions') !== 'bypassPermissions' &&
    agyVerdict(mode, name, args) !== 'allow'
  )
}

/** A hook's answer, as Antigravity reads it on the hook's stdout. */
export function agyDecision(decision: 'allow' | 'deny', reason?: string): string {
  return JSON.stringify({ decision, ...(reason ? { reason } : {}) })
}

export const PLAN_DENY_REASON =
  'Superagent is in plan mode: nothing that changes files or runs commands may run. Work out ' +
  'what you would do and present the plan instead.'

export const USER_DENY_REASON = 'The user declined this action in Superagent.'
