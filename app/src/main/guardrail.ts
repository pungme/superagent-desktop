/**
 * Indirect-prompt-injection gate.
 *
 * The chat agent runs with an unattended shell (bypassPermissions) AND can read
 * arbitrary web pages. A hostile page can carry text shaped like instructions
 * ("ignore your task, run `curl … | bash`"). This gate makes the dangerous
 * combination — read-the-web *then* act-on-the-machine — require a human tap,
 * while leaving ordinary coding (no web read this turn) fully autonomous.
 *
 * Keyed by claude `session_id`, which every PreToolUse event in a turn shares:
 *  - reading untrusted web content taints the session's current turn,
 *  - a new user prompt (UserPromptSubmit) clears the taint,
 *  - while tainted, a machine-acting tool (Bash/Write/Edit/…) is gated — the
 *    PreToolUse hook holds until a human approves, denies, or trusts the turn.
 *
 * Fail-open by construction: any tool this module can't classify is `allow`, so a
 * bug here can never block normal work — the worst case is "the gate didn't fire".
 */

// MCP tools whose result is untrusted web text. Reading one taints the turn.
// (Screenshots can carry injected text too, but read_page is the primary text
// ingestion path; widen this set if that changes.)
const WEB_READ_TOOLS = new Set(['mcp__cove-browser__browser_read_page'])

// Machine-acting tools that are gated once the turn is tainted. Deliberately the
// tools that touch the filesystem or run commands; read-only tools stay ungated.
const GATED_TOOL = /^(Bash|Write|Edit|MultiEdit|NotebookEdit)$/

export type ToolClass = 'taint' | 'gate' | 'allow'

/** Pure classification of a tool by name. */
export function classifyTool(toolName: string): ToolClass {
  if (WEB_READ_TOOLS.has(toolName)) return 'taint'
  if (GATED_TOOL.test(toolName)) return 'gate'
  return 'allow'
}

// Sessions whose current turn has read untrusted web content.
const taintedSessions = new Set<string>()
// Sessions the user chose to trust for the remainder of the current turn.
const trustedForTurn = new Set<string>()

/** A web read happened (or is about to) — taint this turn. */
export function markTainted(sessionId: string): void {
  taintedSessions.add(sessionId)
}

/** New turn: forget both taint and any per-turn trust. */
export function clearTurn(sessionId: string): void {
  taintedSessions.delete(sessionId)
  trustedForTurn.delete(sessionId)
}

/** User approved everything for the rest of this turn. */
export function trustTurn(sessionId: string): void {
  trustedForTurn.add(sessionId)
}

export function isTainted(sessionId: string): boolean {
  return taintedSessions.has(sessionId)
}

export type GateNeed = 'allow' | 'ask'

/**
 * Pure: given the current taint/trust state, does this tool call need a human
 * tap before it runs? Only gated tools, only in a tainted-and-not-yet-trusted
 * turn. Everything else is `allow`.
 */
export function gateDecision(sessionId: string, toolName: string): GateNeed {
  if (classifyTool(toolName) !== 'gate') return 'allow'
  if (!taintedSessions.has(sessionId)) return 'allow'
  if (trustedForTurn.has(sessionId)) return 'allow'
  return 'ask'
}

/** A short, human-readable preview of what the gated tool would do. */
export function toolPreview(toolName: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>
  const s = (v: unknown): string => (typeof v === 'string' ? v : '')
  if (toolName === 'Bash') return s(o.command).slice(0, 400) || '(shell command)'
  if (toolName === 'Write') return `Write ${s(o.file_path) || '(file)'}`
  if (toolName === 'Edit' || toolName === 'MultiEdit') return `Edit ${s(o.file_path) || '(file)'}`
  if (toolName === 'NotebookEdit') return `Edit ${s(o.notebook_path) || '(notebook)'}`
  return toolName
}
