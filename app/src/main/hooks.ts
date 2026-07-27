import { app, BrowserWindow, Notification, ipcMain } from 'electron'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { randomBytes } from 'crypto'
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, chmodSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import { broadcastToWindows, readJsonBody } from './util'

/**
 * Receives Claude Code hook events and turns them into workspace status.
 *
 * How it works:
 *  - SuperAgent spawns `claude` with COVE_HOOK_URL + COVE_WORKSPACE_ID in the env.
 *  - A tiny shell hook (installed once, with consent, into ~/.claude/settings.json)
 *    POSTs the hook JSON to COVE_HOOK_URL/<Event>. It no-ops when the env var is
 *    absent, so non-SuperAgent claude sessions are unaffected.
 *  - We map events → status and push to the renderer; Notification events also
 *    raise a native notification when the window is unfocused.
 */

export type WorkspaceStatus = 'idle' | 'working' | 'needs-you'

const EVENT_STATUS: Record<string, WorkspaceStatus> = {
  UserPromptSubmit: 'working',
  Notification: 'needs-you',
  Stop: 'idle',
  SessionStart: 'idle',
  SubagentStop: 'working'
}

let hookPort = 0
let hookSecret = ''

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
    res.writeHead(200).end('ok')

    const status = EVENT_STATUS[event]
    const sessionId = typeof body.session_id === 'string' ? body.session_id : undefined

    broadcastToWindows('hook:event', { workspaceId, event, status, sessionId, body })

    if (event === 'Notification') {
      const focused = BrowserWindow.getFocusedWindow()
      if (!focused && Notification.isSupported()) {
        const message = typeof body.message === 'string' ? body.message : 'Claude needs your input'
        const n = new Notification({ title: 'SuperAgent — Claude needs you', body: message })
        n.on('click', () => {
          const win = BrowserWindow.getAllWindows()[0]
          if (win) {
            if (win.isMinimized()) win.restore()
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
      console.log(`[hooks] listening at ${url}`)
      resolve(url)
    })
  })
}

export function getHookUrl(): string {
  return hookPort ? `http://127.0.0.1:${hookPort}/hook/${hookSecret}` : ''
}

const HOOK_SCRIPT = `#!/bin/sh
# Installed by SuperAgent. Forwards Claude Code hook events to the SuperAgent app.
# No-ops entirely unless COVE_HOOK_URL is set (i.e. this claude was launched by SuperAgent).
[ -z "$COVE_HOOK_URL" ] && exit 0
curl -sS -X POST "$COVE_HOOK_URL/$1" \\
  -H "x-cove-workspace: \${COVE_WORKSPACE_ID:-}" \\
  -H "content-type: application/json" \\
  --max-time 2 -d @- >/dev/null 2>&1
exit 0
`

const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStop']

type HookSettings = { hooks?: Record<string, unknown[]> } & Record<string, unknown>

/** Pure: additively merge SuperAgent's hooks into a settings object. Idempotent; preserves the user's own hooks. */
export function mergeCoveHooks(settings: HookSettings, scriptPath: string): HookSettings {
  const next: HookSettings = { ...settings, hooks: { ...(settings.hooks ?? {}) } }
  for (const event of HOOK_EVENTS) {
    // Single-quote the path — userData lives under "~/Library/Application Support" (has a space).
    const quoted = `'${scriptPath.replace(/'/g, `'\\''`)}'`
    const command = `sh ${quoted} ${event}`
    const entry = { hooks: [{ type: 'command', command }] }
    const existing = Array.isArray(next.hooks![event]) ? next.hooks![event] : []
    const withoutCove = existing.filter((e) => !JSON.stringify(e).includes('cove-hook.sh'))
    next.hooks![event] = [...withoutCove, entry]
  }
  return next
}

/** Pure: strip every SuperAgent hook back out, dropping now-empty event arrays. */
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
    const stop = settings?.hooks?.Stop
    return JSON.stringify(stop ?? '').includes('cove-hook.sh')
  } catch {
    return false
  }
}

/** Additively merge SuperAgent's hooks into ~/.claude/settings.json. Reversible via uninstallHooks. */
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
  ipcMain.handle('hooks:status', () => hooksInstalled())
  ipcMain.handle('hooks:install', () => installHooks())
  ipcMain.handle('hooks:uninstall', () => {
    uninstallHooks()
    return false
  })
}
