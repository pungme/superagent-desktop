import { BrowserWindow, ipcMain, shell } from 'electron'
import { spawn } from 'child_process'
import { readFileSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { accountEnv, claudeAccountPlace, claudeAccountToken, withAccountEnv } from './accounts'
import { openAuthWindow } from './auth-window'
import { applyBrowserIdentity } from './browser'
import { agentEnv, findClaude } from './claude-cli'
import { isGoogleSignInRejected } from './google-signin'
import { broadcastToWindows } from './util'

/**
 * The user's claude.ai connectors (Superhuman, Attio, Slack…), per Claude
 * account, and connecting one without a terminal.
 *
 * Read from Claude Code 2.1.314:
 *  - A claude.ai connector is a `claudeai-proxy` server. Claude Code lists them
 *    from GET /v1/mcp_servers (needs the user:mcp_servers scope, so a token
 *    account has none) and reaches each through Anthropic's MCP proxy.
 *  - Its sign-in is not Claude Code's: it "doesn't support local OAuth". What
 *    `/mcp` → Authenticate (and the SDK's mcp_authenticate) does is open
 *    `${claude.ai}/api/organizations/<org>/mcp/start-auth/<mcpsrv id>`
 *    (callbackExpected false): claude.ai, signed in as that account, runs the
 *    service's OAuth and keeps the connection on Anthropic's side. Nothing is
 *    written in the config folder; the next session finds it connected.
 *  - Whether each is connected is what `claude mcp list` prints ("✔ Connected",
 *    "! Needs authentication"). It spends no tokens. A -p session's mcp_status
 *    before its first turn lists nothing, so that is not used.
 *
 * So "Connect" here opens that start-auth address in a window of ours, in the
 * account's own cookie jar (the one it signed in with), and reads the list
 * again when the window is done.
 */

export type ConnectorStatus = 'connected' | 'needs-auth' | 'failed' | 'other'

export interface Connector {
  /** As claude.ai names it: "Superhuman Mail". */
  name: string
  url: string
  status: ConnectorStatus
}

/** The claude.ai connectors in `claude mcp list`'s output. */
export function parseMcpList(text: string): Connector[] {
  const out: Connector[] = []
  for (const raw of text.split('\n')) {
    const m = /^claude\.ai (.+?): (\S+) - (.+)$/.exec(raw.trim())
    if (!m) continue
    const said = m[3].trim()
    const status: ConnectorStatus =
      /connected$/i.test(said) && !/!/.test(said)
        ? 'connected'
        : /needs authentication/i.test(said)
          ? 'needs-auth'
          : /failed|error/i.test(said)
            ? 'failed'
            : 'other'
    out.push({ name: m[1], url: m[2], status })
  }
  return out
}

/** Where claude.ai starts a connector's sign-in (Claude Code's ife()). */
export function connectStartUrl(org: string, serverId: string): string {
  const id = serverId.startsWith('mcprs') ? `mcpsrv${serverId.slice(5)}` : serverId
  return `https://claude.ai/api/organizations/${encodeURIComponent(org)}/mcp/start-auth/${encodeURIComponent(id)}?product_surface=cli`
}

/** The organisation an account is signed in to, from its global config. */
export function orgOf(globalConfig: string): string | null {
  try {
    const j = JSON.parse(readFileSync(globalConfig, 'utf8')) as {
      oauthAccount?: { organizationUuid?: string }
    }
    return j.oauthAccount?.organizationUuid ?? null
  } catch {
    return null
  }
}

/** A connector's id on claude.ai, by its name, from the account's own list. */
export async function connectorId(
  token: string,
  name: string,
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  const res = await fetcher('https://api.anthropic.com/v1/mcp_servers?limit=1000', {
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-beta': 'mcp-servers-2025-12-04',
      'anthropic-version': '2023-06-01'
    },
    signal: AbortSignal.timeout(15_000)
  })
  if (!res.ok) return null
  const body = (await res.json()) as { data?: { id?: string; display_name?: string }[] }
  return body.data?.find((s) => s.display_name === name)?.id ?? null
}

/**
 * Connector names an agent's turn says need signing in, out of what it wrote
 * or a tool answered. Claude Code says it three ways: the authenticate tool's
 * "Ask the user to run /mcp and select "claude.ai X" to authenticate", the
 * wait tool's "Needs authentication (ask the user to run /mcp): A, B", and the
 * model's own words naming a connector that is known to need it.
 */
export function connectorsAskedFor(event: Record<string, unknown>, known: string[]): string[] {
  const texts: string[] = []
  const take = (c: unknown): void => {
    if (typeof c === 'string') texts.push(c)
    else if (Array.isArray(c)) c.forEach(take)
    else if (c && typeof c === 'object') {
      const o = c as { text?: unknown; content?: unknown }
      take(o.text)
      take(o.content)
    }
  }
  if (event.type === 'assistant' || event.type === 'user')
    take((event.message as { content?: unknown } | undefined)?.content)
  if (!texts.length) return []
  const text = texts.join('\n')
  const bare = (n: string): string => n.trim().replace(/^claude\.ai /, '')
  // Only a connector this account really has and that really needs signing in:
  // a tool result can be anything (a file the agent read that quotes these very
  // patterns once offered "Connect X", "Connect A", "Connect B\"").
  const has = new Set(known)
  const found = new Set<string>()
  for (const m of text.matchAll(/run \/mcp and select "([^"]+)" to authenticate/g))
    if (has.has(bare(m[1]))) found.add(bare(m[1]))
  for (const m of text.matchAll(/Needs authentication \(ask the user to run \/mcp\): ([^\n]+)/g))
    for (const n of m[1].split(',')) if (has.has(bare(n))) found.add(bare(n))
  // The model's own words, never a tool's output.
  if (
    event.type === 'assistant' &&
    /needs? (to )?(be )?(authenticat|sign|connect)|not (yet )?(authenticated|connected)|\/mcp/i.test(
      text
    )
  )
    for (const n of known) if (text.includes(n)) found.add(n)
  return [...found]
}

// --- per account ----------------------------------------------------------------

const lists = new Map<string, { at: number; connectors: Connector[] }>()

/** What an account's connectors were when last read (no CLI run). */
export function knownConnectors(accountId: string): Connector[] {
  return lists.get(accountId)?.connectors ?? []
}

/** `claude mcp list` as the account: its connectors and whether each is connected. */
function mcpList(env: Record<string, string>, timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve) => {
    let out = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(findClaude(), ['mcp', 'list'], {
        cwd: os.homedir(),
        env: withAccountEnv(agentEnv(findClaude()), env),
        shell: false
      })
    } catch {
      return resolve('')
    }
    const timer = setTimeout(() => proc.kill(), timeoutMs)
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(out)
    })
    proc.on('exit', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

/**
 * An account's claude.ai connectors. A token account has none it can see (its
 * token may not list them), so it is not asked. At most every few minutes
 * unless forced: `claude mcp list` starts every server to check it.
 */
export async function listConnectors(accountId: string, force = false): Promise<Connector[]> {
  const place = claudeAccountPlace(accountId)
  if (!place || (place.kind !== 'login' && place.kind !== 'config')) return []
  const known = lists.get(accountId)
  if (known && !force && Date.now() - known.at < 5 * 60_000) return known.connectors
  const connectors = parseMcpList(await mcpList(accountEnv(accountId)))
  const before = JSON.stringify(known?.connectors ?? null)
  lists.set(accountId, { at: Date.now(), connectors })
  if (before !== JSON.stringify(connectors)) broadcastToWindows('connectors:changed', accountId)
  return connectors
}

/** One line for a window that cannot go further, said once. */
export const CONNECT_BROWSER_NOTE =
  'Google does not allow signing in inside this window. Finish in your browser, signed in to claude.ai as this account; then close this window.'

/**
 * Whether a connect window is done: it went off claude.ai to the service's
 * sign-in and has come back to a claude.ai page that is not the start or a
 * sign-in of claude.ai's own.
 */
export function connectFinished(visited: string[]): boolean {
  const host = (u: string): string => {
    try {
      return new URL(u).hostname
    } catch {
      return ''
    }
  }
  const away = visited.findIndex((u) => host(u) !== 'claude.ai' && !u.startsWith('data:'))
  if (away < 0) return false
  return visited.slice(away + 1).some((u) => {
    if (host(u) !== 'claude.ai') return false
    const path = new URL(u).pathname
    return !/^\/api\/|^\/login|^\/oauth/.test(path)
  })
}

/**
 * Connect one connector: claude.ai's start-auth page in a window of ours, in
 * the account's own cookie jar. Resolves with the connector as it is after.
 */
export async function connectConnector(
  accountId: string,
  name: string,
  parent: BrowserWindow | null
): Promise<{ ok: boolean; connector?: Connector; error?: string }> {
  const place = claudeAccountPlace(accountId)
  if (!place || (place.kind !== 'login' && place.kind !== 'config'))
    return { ok: false, error: 'Sign this account in fully to connect it.' }
  const token = await claudeAccountToken(accountId)
  const org = orgOf(
    place.kind === 'config' && place.configDir
      ? join(place.configDir, '.claude.json')
      : join(os.homedir(), '.claude.json')
  )
  const id = token ? await connectorId(token, name).catch(() => null) : null
  if (!org || !id)
    return {
      ok: false,
      error: 'Could not reach claude.ai for this account. Start a chat on it once, then try again.'
    }
  const url = connectStartUrl(org, id)
  await new Promise<void>((resolve) => {
    const win = openAuthWindow({
      title: `Connect ${name}`,
      width: 560,
      height: 760,
      parent,
      partition: place.partition ?? 'persist:agent-signin',
      prepare: applyBrowserIdentity
    })
    const visited: string[] = []
    let handedOff = false
    const seen = (next: string): void => {
      visited.push(next)
      if (!handedOff && isGoogleSignInRejected(next)) {
        handedOff = true
        void shell.openExternal(url)
        win.loadURL(
          'data:text/html;charset=utf-8,' +
            encodeURIComponent(
              `<!doctype html><meta charset="utf-8"><title>Connect</title><body style="font:14px -apple-system,system-ui;margin:0;display:grid;place-items:center;height:100vh;color:#333"><p style="max-width:360px;text-align:center;line-height:1.5">${CONNECT_BROWSER_NOTE}</p></body>`
            )
        )
        return
      }
      if (connectFinished(visited)) setTimeout(() => win.close(), 800)
    }
    win.page.setWindowOpenHandler(({ url: next }) => {
      if (/^https:/.test(next)) win.loadURL(next)
      return { action: 'deny' }
    })
    win.page.on('did-navigate', (_e, next) => seen(next))
    win.page.on('will-redirect', (_e, next) => seen(next))
    win.onClosed(() => resolve())
    win.loadURL(url)
  })
  const after = await listConnectors(accountId, true)
  const connector = after.find((c) => c.name === name)
  return { ok: connector?.status === 'connected', connector }
}

export function registerConnectorsIpc(): void {
  ipcMain.handle('connectors:list', (_e, accountId: string, force?: boolean) =>
    listConnectors(accountId, force === true)
  )
  ipcMain.handle('connectors:connect', (e, accountId: string, name: string) =>
    connectConnector(accountId, name, BrowserWindow.fromWebContents(e.sender))
  )
}
