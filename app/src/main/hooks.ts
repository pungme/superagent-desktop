import { app, BrowserWindow, Notification, ipcMain } from 'electron'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { EventEmitter } from 'events'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { broadcastToWindows, readJsonBody } from './util'
import { getWorkspaceName, getChatTitleBySession, recordEvent } from './store'
import { paneLog, allowUserFocus } from './browser'
import {
  classifyTool,
  gateDecision,
  markTainted,
  clearTurn,
  trustTurn,
  toolPreview
} from './guardrail'

/**
 * Receives Claude Code hook events and turns them into workspace status.
 *
 * How it works:
 *  - Superagent spawns `claude` with COVE_HOOK_URL + COVE_WORKSPACE_ID in the env.
 *  - A tiny shell hook (installed once, with consent, into ~/.claude/settings.json)
 *    POSTs the hook JSON to COVE_HOOK_URL/<Event>. It no-ops when the env var is
 *    absent, so non-Superagent claude sessions are unaffected.
 *  - We map events → status and push to the renderer; Notification events also
 *    raise a native notification when the window is unfocused.
 */

export type WorkspaceStatus = 'idle' | 'working' | 'needs-you'

// What deserves a banner. The renderer owns the persisted setting and pushes it
// here on startup and on change — banners pop over whatever the user is doing,
// so "Claude is done" must be optional; "needs you" defaults on but can go too.
export const notifyPrefs = { done: true, needsYou: true }

// The tail of each chat's last assistant reply, per workspace — pushed by the
// renderer so the "done" banner can say WHAT finished, not just where.
const lastReplies = new Map<string, string>()

const EVENT_STATUS: Record<string, WorkspaceStatus> = {
  UserPromptSubmit: 'working',
  Notification: 'needs-you',
  Stop: 'idle',
  SessionStart: 'idle',
  SubagentStop: 'working'
}

let hookPort = 0
let hookSecret = ''

/**
 * Hook traffic for the rest of main (the companion, first of all):
 *  'event'         { workspaceId, event, status?, sessionId }
 *  'approval'      { requestId, workspaceId, sessionId, toolName, preview, expiresAt }
 *  'approval-end'  { requestId, outcome, by }
 */
export const hookBus = new EventEmitter()
hookBus.setMaxListeners(50)

// --- Prompt-injection gate: held approvals -------------------------------
// When a tainted turn tries to run a machine-acting tool, the PreToolUse hook
// blocks on the app while a human decides. One entry per outstanding prompt.
interface PendingGate {
  sessionId: string
  resolve: (approved: boolean) => void
  timer: ReturnType<typeof setTimeout>
}
const pendingGates = new Map<string, PendingGate>()
let gateSeq = 0
// If nobody answers, deny — an unattended machine should not run a command that
// a web page may have planted. Bounded so the agent never hangs indefinitely.
const GATE_TIMEOUT_MS = 120_000

export type ApprovalKind = 'guardrail' | 'permission'

// A real permission prompt can wait as long as a person might be away from
// both screens; the injection gate self-denies sooner (an unattended machine
// should not run a planted command).
const PERMISSION_TIMEOUT_MS = 580_000

export function requestApproval(
  workspaceId: string,
  sessionId: string,
  toolName: string,
  preview: string,
  kind: ApprovalKind = 'guardrail'
): Promise<boolean> {
  return new Promise((resolve) => {
    const requestId = `gate-${++gateSeq}`
    const timeoutMs = kind === 'permission' ? PERMISSION_TIMEOUT_MS : GATE_TIMEOUT_MS
    const timer = setTimeout(() => {
      pendingGates.delete(requestId)
      broadcastToWindows('guardrail:resolved', { requestId })
      hookBus.emit('approval-end', { requestId, outcome: 'expired', by: 'desktop' })
      resolve(false)
    }, timeoutMs)
    pendingGates.set(requestId, { sessionId, resolve, timer })
    broadcastToWindows('guardrail:ask', {
      requestId,
      workspaceId,
      sessionId,
      toolName,
      preview,
      kind
    })
    hookBus.emit('approval', {
      requestId,
      workspaceId,
      sessionId,
      toolName,
      preview,
      kind,
      expiresAt: Date.now() + timeoutMs
    })
  })
}

/**
 * The PermissionRequest verdict for chats in "Ask" mode. Unlike the gate, a
 * denial here is the user's plain answer, so the message stays neutral.
 */
async function decidePermission(
  workspaceId: string,
  body: Record<string, unknown>
): Promise<string> {
  const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
  const toolName = typeof body.tool_name === 'string' ? body.tool_name : ''
  if (!sessionId || !toolName) return ''
  const preview = toolPreview(toolName, body.tool_input)
  const approved = await requestApproval(workspaceId, sessionId, toolName, preview, 'permission')
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: approved
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: 'The user declined this action in Superagent.' }
    }
  })
}

/**
 * Answer a held approval — from the window or from a paired phone. First
 * answer wins; a late one reports false so the caller can say "already
 * decided". `trustRest` waves through the rest of this (tainted) turn.
 */
export function resolveGate(
  requestId: string,
  approve: boolean,
  trustRest: boolean,
  by: 'desktop' | 'ios'
): boolean {
  const p = pendingGates.get(requestId)
  if (!p) return false
  pendingGates.delete(requestId)
  clearTimeout(p.timer)
  if (approve && trustRest) trustTurn(p.sessionId)
  p.resolve(!!approve)
  // Whoever didn't answer sees it settle.
  broadcastToWindows('guardrail:resolved', { requestId })
  hookBus.emit('approval-end', { requestId, outcome: approve ? 'approved' : 'denied', by })
  return true
}

const DENY_JSON = (reason: string): string =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  })

/**
 * The PreToolUse verdict. Returns '' to allow (the common path), or a deny JSON
 * to block. Fail-open: anything we can't reason about is allowed, so the gate can
 * never wedge the agent.
 */
async function decidePreTool(workspaceId: string, body: Record<string, unknown>): Promise<string> {
  const sessionId = typeof body.session_id === 'string' ? body.session_id : ''
  const toolName = typeof body.tool_name === 'string' ? body.tool_name : ''
  if (!sessionId || !toolName) return ''

  const cls = classifyTool(toolName)
  if (cls === 'taint') {
    markTainted(sessionId)
    return ''
  }
  if (cls === 'allow') return ''
  // A gated tool. Only asks when the turn is tainted and not yet trusted.
  if (gateDecision(sessionId, toolName) === 'allow') return ''

  const preview = toolPreview(toolName, body.tool_input)
  const approved = await requestApproval(workspaceId, sessionId, toolName, preview)
  if (approved) return ''
  return DENY_JSON(
    'Blocked by Superagent: this turn read untrusted web content, and the user did not ' +
      'approve this action. Do not retry it. Tell the user plainly what you were about to do ' +
      'and let them decide.'
  )
}

export function startHookServer(): Promise<string> {
  hookSecret = randomBytes(12).toString('hex')
  const base = `/hook/${hookSecret}`

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !req.url?.startsWith(base)) {
      res.writeHead(404).end()
      return
    }
    const event = req.url.slice(base.length + 1).split('?')[0] || 'unknown'
    const workspaceId = (req.headers['x-cove-workspace'] as string) || ''
    const body = await readJsonBody(req)

    // The one event we answer synchronously: the tool gate. The verdict body is
    // read by Claude Code ('' = allow, deny JSON = block). Everything else is a
    // fire-and-forget status ping answered with 'ok'.
    if (event === 'PreToolUse') {
      const verdict = await decidePreTool(workspaceId, body)
      res.writeHead(200, { 'content-type': 'application/json' }).end(verdict)
      return
    }
    if (event === 'PermissionRequest') {
      const verdict = await decidePermission(workspaceId, body)
      res.writeHead(200, { 'content-type': 'application/json' }).end(verdict)
      return
    }
    res.writeHead(200).end('ok')

    // A fresh user turn clears any untrusted-web-content taint from the last one.
    if (event === 'UserPromptSubmit') {
      const sid = typeof body.session_id === 'string' ? body.session_id : ''
      if (sid) clearTurn(sid)
    }

    const status = EVENT_STATUS[event]
    const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined

    broadcastToWindows('hook:event', { workspaceId, event, status, sessionId, body })
    hookBus.emit('event', {
      workspaceId,
      event,
      status,
      sessionId,
      detail:
        event === 'Notification' && typeof body.message === 'string'
          ? body.message
          : event === 'Stop'
            ? lastReplies.get(workspaceId)
            : undefined
    })

    if (event === 'Notification') {
      const focused = BrowserWindow.getFocusedWindow()
      if (!focused && Notification.isSupported() && notifyPrefs.needsYou) {
        const message = typeof body.message === 'string' ? body.message : 'Claude needs your input'
        const name = getWorkspaceName(workspaceId)
        const about = sessionId ? getChatTitleBySession(sessionId) : undefined
        // Which project, and which conversation within it — with several agents
        // running, "Claude needs you" alone doesn't say where to look.
        const n = new Notification({
          title: name ? `Claude needs you — ${name}` : 'Superagent — Claude needs you',
          subtitle: about,
          body: message
        })
        n.on('click', () => {
          const win = BrowserWindow.getAllWindows()[0]
          if (win) {
            if (win.isMinimized()) win.restore()
            paneLog('notification-click-focus', workspaceId)
            allowUserFocus() // deliberate: don't bounce this one back
            win.focus()
            win.webContents.send('hook:focus-workspace', workspaceId)
          }
        })
        n.show()
      }
    }

    // Agent finished a turn: if the user has switched to another app, ping them
    // with a notification instead of pulling the window forward. Click focuses
    // the project. (When the app is already frontmost, stay quiet.)
    if (event === 'Stop') {
      recordEvent('turn', workspaceId)
      const focused = BrowserWindow.getFocusedWindow()
      if (!focused && Notification.isSupported() && notifyPrefs.done) {
        const name = getWorkspaceName(workspaceId)
        // Chats name themselves after what they turned out to be about, so the
        // title is the closest thing we have to "what was it about".
        const about = sessionId ? getChatTitleBySession(sessionId) : undefined
        const reply = lastReplies.get(workspaceId)
        const n = new Notification({
          title: name ? `Claude is done — ${name}` : 'Superagent — Claude is done',
          subtitle: about,
          // The reply's opening line is the closest thing to "what happened";
          // when there's none (a turn that ended on tool calls, say), invite the
          // click rather than saying "finished its turn", which means nothing to
          // a person.
          body: reply || 'Tap to see what it did.'
        })
        n.on('click', () => {
          const win = BrowserWindow.getAllWindows()[0]
          if (win) {
            if (win.isMinimized()) win.restore()
            paneLog('notification-click-focus', workspaceId)
            allowUserFocus() // deliberate: don't bounce this one back
            win.focus()
            win.webContents.send('hook:focus-workspace', workspaceId)
          }
        })
        n.show()
      }
    }
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      hookPort = typeof addr === 'object' && addr ? addr.port : 0
      const url = `http://127.0.0.1:${hookPort}${base}`
      // Host:port only — `base` carries the per-launch secret; keep it out of logs.
      console.log(`[hooks] listening on 127.0.0.1:${hookPort}`)
      resolve(url)
    })
  })
}

export function getHookUrl(): string {
  return hookPort ? `http://127.0.0.1:${hookPort}/hook/${hookSecret}` : ''
}

const HOOK_SCRIPT = `#!/bin/sh
# Installed by Superagent. Forwards Claude Code hook events to the Superagent app.
# No-ops entirely unless COVE_HOOK_URL is set (i.e. this claude was launched by Superagent).
[ -z "$COVE_HOOK_URL" ] && exit 0
if [ "$1" = "PreToolUse" ] || [ "$1" = "PermissionRequest" ]; then
  # Decision hook. The app replies with an empty body to allow the tool, or a
  # PreToolUse permissionDecision JSON to block it — forward that verbatim to
  # stdout, which is how Claude Code reads the verdict. Fail open: if the app is
  # unreachable and curl times out, we print nothing and exit 0 (tool proceeds),
  # so the guardrail can never wedge the agent.
  resp=$(curl -sS -X POST "$COVE_HOOK_URL/$1" \\
    -H "x-cove-workspace: \${COVE_WORKSPACE_ID:-}" \\
    -H "content-type: application/json" \\
    --max-time 590 -d @- 2>/dev/null)
  [ -n "$resp" ] && printf '%s' "$resp"
  exit 0
fi
curl -sS -X POST "$COVE_HOOK_URL/$1" \\
  -H "x-cove-workspace: \${COVE_WORKSPACE_ID:-}" \\
  -H "content-type: application/json" \\
  --max-time 2 -d @- >/dev/null 2>&1
exit 0
`

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop']

type HookSettings = { hooks?: Record<string, unknown[]> } & Record<string, unknown>

/** Pure: additively merge Superagent's hooks into a settings object. Idempotent; preserves the user's own hooks. */
export function mergeCoveHooks(settings: HookSettings, scriptPath: string): HookSettings {
  const next: HookSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } }
  // Single-quote the path — userData lives under "~/Library/Application Support" (has a space).
  const quoted = `'${scriptPath.replace(/'/g, `'\\''`)}'`
  const addEntry = (event: string, entry: unknown): void => {
    const existing = Array.isArray(next.hooks![event]) ? next.hooks![event] : []
    const withoutCove = existing.filter((e) => !JSON.stringify(e).includes('cove-hook.sh'))
    next.hooks![event] = [...withoutCove, entry]
  }
  for (const event of HOOK_EVENTS) {
    addEntry(event, { hooks: [{ type: 'command', command: `sh ${quoted} ${event}` }] })
  }
  // The prompt-injection gate. Fires only for the web-read tool (to taint the
  // turn) and the machine-acting tools (to gate them); the same script routes on
  // the 'PreToolUse' arg and forwards the app's verdict. Generous timeout so a
  // held human approval isn't cut off (the app self-denies well before this).
  addEntry('PreToolUse', {
    matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit|mcp__cove-browser__browser_read_page',
    hooks: [{ type: 'command', command: `sh ${quoted} PreToolUse`, timeout: 600 }]
  })
  // Real tool approvals, for chats running in the "Ask" mode: Claude Code asks
  // the app instead of a terminal prompt, and the app asks the user — on the
  // Mac or on a paired phone. Other modes never emit this event.
  addEntry('PermissionRequest', {
    hooks: [{ type: 'command', command: `sh ${quoted} PermissionRequest`, timeout: 600 }]
  })
  return next
}

/** Pure: strip every Superagent hook back out, dropping now-empty event arrays. */
export function removeCoveHooks(settings: HookSettings): HookSettings {
  if (!settings.hooks) return settings
  const hooks: Record<string, unknown> = {}
  for (const [event, arr] of Object.entries(settings.hooks)) {
    if (!Array.isArray(arr)) {
      // Preserve anything we don't recognize rather than silently dropping it.
      hooks[event] = arr
      continue
    }
    const kept = arr.filter((e) => !JSON.stringify(e).includes('cove-hook.sh'))
    if (kept.length > 0) hooks[event] = kept
  }
  return { ...settings, hooks: hooks as HookSettings['hooks'] }
}

function hookScriptPath(): string {
  return join(app.getPath('userData'), 'cove-hook.sh')
}

function claudeSettingsPath(): string {
  return join(homedir(), '.claude', 'settings.json')
}

/** Write settings.json atomically (temp + rename) so a crash mid-write can never
 * leave the user's real Claude config truncated. */
function writeSettingsAtomic(settingsPath: string, settings: HookSettings): void {
  const tmp = `${settingsPath}.cove-tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2))
  renameSync(tmp, settingsPath)
}

export function hooksInstalled(): boolean {
  const path = claudeSettingsPath()
  if (!existsSync(path)) return false
  try {
    const settings = JSON.parse(readFileSync(path, 'utf8'))
    // Require the PreToolUse gate too, not just the status hooks — so an install
    // from a version that predates the guardrail reads as "not current" and gets
    // re-merged (idempotently) on launch, picking up the gate.
    const stop = settings?.hooks?.Stop
    const pre = settings?.hooks?.PreToolUse
    const perm = settings?.hooks?.PermissionRequest
    return (
      JSON.stringify(stop ?? '').includes('cove-hook.sh') &&
      JSON.stringify(pre ?? '').includes('cove-hook.sh') &&
      JSON.stringify(perm ?? '').includes('cove-hook.sh')
    )
  } catch {
    return false
  }
}

/** Additively merge Superagent's hooks into ~/.claude/settings.json. Reversible via uninstallHooks. */
export function installHooks(): { ok: boolean; error?: string } {
  try {
    const scriptPath = hookScriptPath()
    writeFileSync(scriptPath, HOOK_SCRIPT, { mode: 0o755 })
    chmodSync(scriptPath, 0o755)

    const settingsPath = claudeSettingsPath()
    mkdirSync(dirname(settingsPath), { recursive: true })
    const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}

    writeSettingsAtomic(settingsPath, mergeCoveHooks(settings, scriptPath))
    console.log('[hooks] installed into', settingsPath)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function uninstallHooks(): void {
  const settingsPath = claudeSettingsPath()
  if (!existsSync(settingsPath)) return
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'))
    writeSettingsAtomic(settingsPath, removeCoveHooks(settings))
  } catch {
    // best effort
  }
}

export function registerHookIpc(): void {
  // Module scope must stay Electron-free (tests import this file): IPC wiring
  // belongs here, at registration time.
  ipcMain.on('chat:last-reply', (_e, workspaceId: string, excerpt: string) => {
    if (typeof workspaceId === 'string' && typeof excerpt === 'string') {
      lastReplies.set(workspaceId, excerpt.slice(0, 180))
    }
  })
  ipcMain.on('notify:prefs', (_e, prefs: { done?: boolean; needsYou?: boolean }) => {
    if (typeof prefs.done === 'boolean') notifyPrefs.done = prefs.done
    if (typeof prefs.needsYou === 'boolean') notifyPrefs.needsYou = prefs.needsYou
  })
  // The user answered a prompt-injection gate. `trustRest` waves through the rest
  // of this (tainted) turn so a legitimate browse-then-code flow isn't a tap per
  // command.
  ipcMain.on('guardrail:resolve', (_e, requestId: string, approve: boolean, trustRest: boolean) =>
    resolveGate(requestId, approve, trustRest, 'desktop')
  )
  ipcMain.handle('hooks:status', () => hooksInstalled())
  ipcMain.handle('hooks:install', () => installHooks())
  ipcMain.handle('hooks:uninstall', () => {
    uninstallHooks()
    return false
  })
}
