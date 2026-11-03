import { app, BrowserWindow, ipcMain, safeStorage, session } from 'electron'
import { signInAgent } from './agent-signin'
import { healthLog } from './health'
import { execFile, spawn } from 'child_process'
import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import os from 'os'
import { join } from 'path'
import { agentEnv, findAgy, findClaude, findCodex } from './claude-cli'
import { CodexClient } from './codex/client'
import { broadcastToWindows } from './util'
import {
  usageFromAntigravity,
  usageFromClaudeApi,
  usageFromClaudeHeaders,
  usageFromCodex,
  type Usage
} from './usage'
import type { AgentProvider } from '../shared/agent-provider'

export type { Usage, UsageWindow } from './usage'

/**
 * More than one subscription per agent, so a chat can carry on when one hits
 * its limit.
 *
 * Each CLI keeps one login of its own — the "login" account below, which is
 * whatever `claude auth login` / `codex login` set up and needs nothing from
 * us. Extra accounts ride on top without disturbing it:
 *
 *  - Claude, signed in fully ('config'): `claude auth login` run with its own
 *    CLAUDE_CONFIG_DIR, a folder of ours whose entries are symlinks back to
 *    ~/.claude except the ones that belong to an account (see linkClaudeConfigDir).
 *    A full login carries every scope, so claude.ai connectors, Claude in Chrome
 *    and Remote Control work on it as on the main login.
 *  - Claude, by token ('token'): a long-lived token from `claude setup-token`,
 *    handed to the CLI as CLAUDE_CODE_OAUTH_TOKEN. Verified against 2.1.283:
 *    the env var wins over the Keychain login, and the config folder stays
 *    shared. Claude Code limits such a token to inference only, so a token
 *    account never sees the claude.ai connectors (they need user:mcp_servers).
 *  - Codex: its own CODEX_HOME folder holding just that account's auth.json;
 *    everything else in it is a symlink back to ~/.codex, so config, skills
 *    and threads are shared the same way.
 *
 * Tokens are safeStorage-encrypted on disk. A limit is remembered until the
 * reset time the CLI reported, so the picker skips that account meanwhile.
 */

export interface Account {
  id: string
  provider: AgentProvider
  name: string
  /**
   * The CLI's own login, an extra Claude token, an extra Codex home, or an
   * extra Claude login in a config folder of its own.
   */
  kind: AccountKind
  /** Epoch ms until which this account is known to be out of allowance. */
  limitedUntil: number | null
  /** Who it is: "campaigns@songpush.com · Max" for a login; when a token was added. */
  detail: string
  /**
   * The CLI refused this account's credentials (a revoked token, a logged-out
   * CLI): the one-line reason, until a session starts on it again.
   */
  needsAuth: string | null
  /** How much of its allowance is used, as last read — null until it has been. */
  usage: Usage | null
  /** The account new chats of this agent start on (the login unless one was chosen). */
  isDefault: boolean
}

export type AccountKind = 'login' | 'token' | 'home' | 'config'

/** Extra accounts, as written to disk. Tokens are stored encrypted. */
interface StoredAccount {
  id: string
  provider: AgentProvider
  name: string
  kind: 'token' | 'home' | 'config'
  addedAt?: number
  /** base64 of the safeStorage-encrypted token (Claude). */
  token?: string
  /** CODEX_HOME folder (Codex). */
  home?: string
  /** CLAUDE_CONFIG_DIR folder (Claude, signed in fully). */
  configDir?: string
  /** Who it signed in as: "campaigns@songpush.com · Max plan" (config). */
  who?: string
  /**
   * The cookie jar its sign-in window used (config): claude.ai stays signed in
   * there as this account, which is what connecting a connector needs.
   */
  partition?: string
}

export type LimitMode = 'ask' | 'auto'

interface AccountsFile {
  accounts: StoredAccount[]
  mode: LimitMode
  limits: Record<string, number>
  chats: Record<string, string>
  /** Accounts whose credentials the CLI last refused, with its reason. */
  auth: Record<string, string>
  /** What each account last said about its allowance (see usage.ts). */
  usage: Record<string, Usage>
  /** Per agent, the account new chats start on, when the user chose one. */
  defaults: Partial<Record<AgentProvider, string>>
}

/** What the window is told when an account runs dry. */
export interface LimitNotice {
  chatId: string
  provider: AgentProvider
  account: { id: string; name: string }
  until: number | null
  alternatives: { id: string; name: string }[]
  /** Set when the mode is auto and the chat already moved. */
  switchedTo: { id: string; name: string } | null
  mode: LimitMode
}

export const LOGIN_ID: Record<AgentProvider, string> = {
  claude: 'claude:login',
  codex: 'codex:login',
  antigravity: 'antigravity:login'
}
const LOGIN_NAME: Record<AgentProvider, string> = {
  claude: 'Your Claude login',
  codex: 'Your Codex login',
  antigravity: 'Your Antigravity login'
}
/** With no reset time reported, assume the usual five-hour window. */
export const DEFAULT_LIMIT_MS = 5 * 3_600_000

let file: AccountsFile | null = null
/** What the CLIs say about their own logins (`claude auth status`, `codex login status`). */
interface LoginState {
  /** "campaigns@songpush.com · Max", "ChatGPT". */
  detail: string
  signedIn: boolean
}
const logins: Partial<Record<AgentProvider, LoginState>> = {}
const SIGN_IN_HINT: Record<AgentProvider, string> = {
  claude: 'Not signed in — run `claude auth login` in Terminal',
  codex: 'Not signed in — run `codex login` in Terminal',
  antigravity: 'Not signed in — run `agy` in Terminal'
}

function filePath(): string {
  return join(process.env.COVE_USER_DATA || app.getPath('userData'), 'accounts.json')
}

function load(): AccountsFile {
  if (file) return file
  try {
    const raw = JSON.parse(readFileSync(filePath(), 'utf8')) as Partial<AccountsFile>
    file = {
      accounts: Array.isArray(raw.accounts) ? raw.accounts : [],
      mode: raw.mode === 'auto' ? 'auto' : 'ask',
      limits: raw.limits && typeof raw.limits === 'object' ? raw.limits : {},
      chats: raw.chats && typeof raw.chats === 'object' ? raw.chats : {},
      auth: raw.auth && typeof raw.auth === 'object' ? raw.auth : {},
      usage: raw.usage && typeof raw.usage === 'object' ? raw.usage : {},
      defaults: raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {}
    }
  } catch {
    file = { accounts: [], mode: 'ask', limits: {}, chats: {}, auth: {}, usage: {}, defaults: {} }
  }
  return file
}

function save(): void {
  const f = load()
  mkdirSync(join(filePath(), '..'), { recursive: true })
  writeFileSync(filePath(), JSON.stringify(f, null, 2), { mode: 0o600 })
}

function encrypt(text: string): string {
  return (
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(text)
      : Buffer.from(text, 'utf8')
  ).toString('base64')
}

function decrypt(b64: string): string {
  const raw = Buffer.from(b64, 'base64')
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString('utf8')
  } catch {
    return raw.toString('utf8')
  }
}

function limitedUntil(id: string): number | null {
  const f = load()
  const until = f.limits[id]
  if (!until) return null
  if (until <= Date.now()) {
    delete f.limits[id]
    save()
    return null
  }
  return until
}

/** Every account for a provider, the CLI's own login first. */
export function listAccounts(provider: AgentProvider): Account[] {
  const f = load()
  const state = logins[provider]
  const chosen = defaultAccountId(provider)
  const login: Account = {
    id: LOGIN_ID[provider],
    provider,
    name: LOGIN_NAME[provider],
    kind: 'login',
    limitedUntil: limitedUntil(LOGIN_ID[provider]),
    detail: state ? (state.signedIn ? state.detail : '') : 'Checking…',
    needsAuth:
      state && !state.signedIn ? SIGN_IN_HINT[provider] : (f.auth[LOGIN_ID[provider]] ?? null),
    usage: f.usage[LOGIN_ID[provider]] ?? null,
    isDefault: chosen === LOGIN_ID[provider]
  }
  return [
    login,
    ...f.accounts
      .filter((a) => a.provider === provider)
      .map((a) => ({
        id: a.id,
        provider,
        name: a.name,
        kind: a.kind,
        limitedUntil: limitedUntil(a.id),
        detail:
          a.kind === 'config' && a.who
            ? a.who
            : (a.kind === 'token' ? 'Token' : 'Signed in') +
              (a.addedAt ? ` · added ${new Date(a.addedAt).toLocaleDateString()}` : ''),
        needsAuth: f.auth[a.id] ?? null,
        usage: f.usage[a.id] ?? null,
        isDefault: chosen === a.id
      }))
  ]
}

export function limitMode(): LimitMode {
  return load().mode
}

export function setLimitMode(mode: LimitMode): void {
  load().mode = mode === 'auto' ? 'auto' : 'ask'
  save()
}

/**
 * The account new chats of this agent start on: the one the user chose, while
 * it still exists, else the CLI's own login.
 */
function defaultAccountId(provider: AgentProvider): string {
  const f = load()
  const id = f.defaults[provider]
  if (id && f.accounts.some((a) => a.id === id && a.provider === provider)) return id
  return LOGIN_ID[provider]
}

/** Choose which account new chats of this agent start on. */
export function setDefaultAccount(provider: AgentProvider, accountId: string): void {
  const f = load()
  if (accountId === LOGIN_ID[provider]) delete f.defaults[provider]
  else if (f.accounts.some((a) => a.id === accountId && a.provider === provider))
    f.defaults[provider] = accountId
  else throw new Error('No such account.')
  save()
  broadcastToWindows('accounts:changed')
}

/**
 * Which account a chat runs on: its own pick while that has allowance, else
 * the default the user chose while that has, else the first that has (the
 * CLI's own login first). With every account out: the pick, else the default.
 */
export function accountForChat(provider: AgentProvider, chatId: string | undefined): Account {
  const all = listAccounts(provider)
  const pinned = chatId ? all.find((a) => a.id === load().chats[chatId]) : undefined
  if (pinned && !pinned.limitedUntil) return pinned
  const chosen = all.find((a) => a.isDefault)
  if (chosen && !chosen.limitedUntil) return chosen
  return all.find((a) => !a.limitedUntil) ?? pinned ?? chosen ?? all[0]
}

export function pinChatAccount(chatId: string, accountId: string): void {
  load().chats[chatId] = accountId
  save()
}

/** The env additions that make a CLI run as this account. None for its own login. */
export function accountEnv(accountId: string): Record<string, string> {
  const stored = load().accounts.find((a) => a.id === accountId)
  if (!stored) return {}
  if (stored.kind === 'token' && stored.token)
    return { CLAUDE_CODE_OAUTH_TOKEN: decrypt(stored.token) }
  if (stored.kind === 'home' && stored.home) {
    linkCodexHome(stored.home)
    return { CODEX_HOME: stored.home }
  }
  if (stored.kind === 'config' && stored.configDir) {
    linkClaudeConfigDir(stored.configDir)
    return { CLAUDE_CONFIG_DIR: stored.configDir }
  }
  return {}
}

/**
 * The environment a CLI process gets: `base` with the account's additions.
 *
 * An account in its own config folder must never also carry a token: Claude
 * Code takes CLAUDE_CODE_OAUTH_TOKEN over any login, so a token left in
 * Superagent's own environment would run that chat on the token's account,
 * with inference-only scopes, and the full login would be ignored in silence.
 */
export function withAccountEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string>
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra }
  if (extra.CLAUDE_CONFIG_DIR) delete env.CLAUDE_CODE_OAUTH_TOKEN
  return env
}

/**
 * Remember that an account is out until `until` (epoch ms; null means the
 * CLI said nothing, so the usual window is assumed).
 */
export function markLimited(accountId: string, until: number | null): number {
  const at = until && until > Date.now() ? until : Date.now() + DEFAULT_LIMIT_MS
  load().limits[accountId] = at
  save()
  return at
}

/** One model out of allowance on this Mac's accounts, until the reset. */
export function markModelLimited(family: string, until: number | null): number {
  return markLimited(`model:${family}`, until)
}

export function modelLimitedUntil(family: string | null): number | null {
  return family ? limitedUntil(`model:${family}`) : null
}

export function clearLimit(accountId: string): void {
  delete load().limits[accountId]
  save()
}

/** The CLI refused (or, with null, accepted again) this account's credentials. */
export function markAuth(accountId: string, reason: string | null): void {
  const f = load()
  if (reason) f.auth[accountId] = reason
  else if (!(accountId in f.auth)) return
  else delete f.auth[accountId]
  save()
  broadcastToWindows('accounts:changed')
}

/**
 * A result or stderr line that means the credentials were refused, not that
 * the account is out — that's `limitFromEvent`. The reason, trimmed, or null.
 */
export function authFailureFrom(text: string): string | null {
  const m =
    /(invalid api key|authentication[_ ](error|failed)|oauth token (expired|revoked|invalid)|not logged in|please run \/login|please log ?in|token (has )?expired|401 unauthorized|unauthorized)/i.exec(
      text
    )
  if (!m) return null
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().includes(m[0].toLowerCase()))
  // eslint-disable-next-line no-control-regex
  return (line ?? m[0]).replace(/\x1b\[[0-9;]*m/g, '').slice(0, 160)
}

export function authFailureFromEvent(event: Record<string, unknown>): string | null {
  if (event.type !== 'result' || !event.is_error) return null
  const text = [event.result, ...((event.errors as unknown[]) ?? [])]
    .map((e) => (typeof e === 'string' ? e : JSON.stringify(e ?? '')))
    .join('\n')
  return authFailureFrom(text)
}

/**
 * An account ran dry mid-chat. Decide what happens — move the chat now (auto)
 * or leave the choice to the user (ask) — and tell the windows either way.
 */
export function reportLimit(
  chatId: string,
  provider: AgentProvider,
  accountId: string,
  until: number | null
): LimitNotice {
  const at = markLimited(accountId, until)
  const all = listAccounts(provider)
  const account = all.find((a) => a.id === accountId) ?? all[0]
  const alternatives = all.filter((a) => a.id !== accountId && !a.limitedUntil)
  const mode = limitMode()
  let switchedTo: Account | null = null
  if (mode === 'auto' && alternatives.length) {
    switchedTo = alternatives[0]
    pinChatAccount(chatId, switchedTo.id)
  }
  const notice: LimitNotice = {
    chatId,
    provider,
    account: { id: account.id, name: account.name },
    until: at,
    alternatives: alternatives.map((a) => ({ id: a.id, name: a.name })),
    switchedTo: switchedTo ? { id: switchedTo.id, name: switchedTo.name } : null,
    mode
  }
  broadcastToWindows('accounts:limit', notice)
  return notice
}

// --- what the CLIs say when they run dry -------------------------------------

/**
 * A stream-json event that means "this account is out", with the reset time
 * if the CLI gave one. Claude sends `rate_limit_event` (status rejected,
 * resetsAt in epoch seconds) ahead of the failed result; both CLIs put the
 * reason in the result text.
 */
export interface Limit {
  until: number | null
  /**
   * Set when only one model is out ("You've reached your Fable limit"), not the
   * account: the chat moves to the next model down rather than to another
   * account. The CLI's --fallback-model does not cover usage limits — only a
   * model that is overloaded or unavailable — so Superagent makes the move.
   */
  model?: string
}

const MODEL_LIMIT_TYPES: Record<string, string> = {
  seven_day_opus: 'opus',
  seven_day_sonnet: 'sonnet',
  seven_day_overage_included: 'fable'
}

export function limitFromEvent(event: Record<string, unknown>): Limit | null {
  if (event.type === 'rate_limit_event') {
    const info = event.rate_limit_info as
      { status?: string; resetsAt?: number; rateLimitType?: string } | undefined
    if (info?.status !== 'rejected') return null
    const model = MODEL_LIMIT_TYPES[info.rateLimitType ?? '']
    return { until: epochMs(info.resetsAt), ...(model ? { model } : {}) }
  }
  // The failed result, or the synthetic assistant message the CLI puts the
  // same words in.
  let text = ''
  if (event.type === 'result' && event.is_error)
    text = [event.result, ...((event.errors as unknown[]) ?? [])]
      .map((e) => (typeof e === 'string' ? e : JSON.stringify(e ?? '')))
      .join('\n')
  else if (event.type === 'assistant') {
    const msg = event.message as { model?: string; content?: { text?: string }[] } | undefined
    if (msg?.model === '<synthetic>') text = (msg.content ?? []).map((c) => c.text ?? '').join('\n')
  }
  if (!text) return null
  const model = /reached your (fable|mythos|opus|sonnet|haiku) limit/i.exec(text)?.[1]
  if (model) return { until: null, model: model.toLowerCase() }
  if (/hit your (usage )?limit|usage limit|out of (usage|credits)|limit reached/i.test(text))
    return { until: null }
  return null
}

/**
 * Whether a limit the CLI reported actually ended the turn.
 *
 * "Rejected" is about one request. With a fallback model behind it the CLI
 * carries the turn on (Fable's allowance gone, Opus takes over), and offering
 * another account then would be answering a question nobody asked. So a
 * reported limit is held until the turn's result: a failed turn means the
 * account is out; a fallback, or a turn that finished, means it is not.
 */
export class LimitGate {
  private held: Limit | null = null

  hold(limit: Limit): void {
    // The first report of a turn carries the reset time; the text carries
    // which model. Keep both, whichever order they come in.
    const until = this.held?.until ?? limit.until
    const model = this.held?.model ?? limit.model
    this.held = { until, ...(model ? { model } : {}) }
  }

  fellBack(): void {
    this.held = null
  }

  /** The turn's result: the limit to act on, or null. Clears what was held. */
  result(event: Record<string, unknown>): Limit | null {
    const held = this.held
    this.held = null
    if (event.type !== 'result' || !event.is_error) return null
    return held
  }
}

/** Codex's `account/rateLimits/updated`: out when a window is fully used. */
export function limitFromCodexRateLimits(
  params: Record<string, unknown>
): { until: number | null } | null {
  const limits = params.rateLimits as
    Record<string, { usedPercent?: number; resetsAt?: number } | undefined> | undefined
  if (!limits) return null
  for (const key of ['primary', 'secondary']) {
    const w = limits[key]
    if (w && typeof w.usedPercent === 'number' && w.usedPercent >= 100)
      return { until: epochMs(w.resetsAt) }
  }
  return null
}

/** Seconds or milliseconds since the epoch → milliseconds. */
export function epochMs(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null
  return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
}

// --- adding accounts ------------------------------------------------------------

export const CLAUDE_TOKEN_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/

export function addClaudeToken(name: string, token: string): Account {
  const clean = token.trim()
  if (!CLAUDE_TOKEN_RE.test(clean))
    throw new Error('That does not look like a token from `claude setup-token`.')
  const id = `claude:${randomUUID()}`
  const addedAt = Date.now()
  load().accounts.push({
    id,
    provider: 'claude',
    name: name.trim() || 'Claude account',
    kind: 'token',
    addedAt,
    token: encrypt(clean)
  })
  save()
  return listAccounts('claude').find((a) => a.id === id)!
}

function codexHomeRoot(): string {
  return join(process.env.COVE_USER_DATA || app.getPath('userData'), 'codex-accounts')
}

/**
 * Make `home` a Codex home that shares everything with ~/.codex except the
 * login: every entry there but auth.json is symlinked in. Safe to repeat —
 * anything ~/.codex gained since is linked next time.
 */
export function linkCodexHome(home: string, source = join(os.homedir(), '.codex')): void {
  mkdirSync(home, { recursive: true })
  if (!existsSync(source)) return
  for (const entry of readdirSync(source)) {
    if (entry === 'auth.json') continue
    const target = join(home, entry)
    if (existsSync(target)) continue
    try {
      symlinkSync(join(source, entry), target)
    } catch {
      // A file Codex already wrote here of its own; leave it.
    }
  }
}

/**
 * Sign a second Codex account in: `codex login` with its own CODEX_HOME opens
 * the browser and writes auth.json there when the user is through.
 */
export function addCodexAccount(name: string): Promise<Account> {
  const id = `codex:${randomUUID()}`
  const home = join(codexHomeRoot(), id.replace(':', '-'))
  linkCodexHome(home)
  return new Promise((resolve, reject) => {
    const proc = spawn(findCodex(), ['login'], {
      env: agentEnv(findCodex(), { ...process.env, CODEX_HOME: home }),
      cwd: os.homedir(),
      shell: false
    })
    let out = ''
    const fail = (why: string): void => {
      clearTimeout(timer)
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        // best effort
      }
      reject(new Error(why))
    }
    const timer = setTimeout(() => {
      proc.kill()
      fail('The sign-in took too long. Try again.')
    }, 10 * 60_000)
    proc.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.stderr.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.on('error', (e) => fail(e.message))
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0 || !existsSync(join(home, 'auth.json'))) {
        fail(
          out
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .pop() ?? 'Codex did not finish signing in.'
        )
        return
      }
      const account: StoredAccount = {
        id,
        provider: 'codex',
        name: name.trim() || 'Codex account',
        kind: 'home',
        addedAt: Date.now(),
        home
      }
      load().accounts.push(account)
      save()
      resolve(listAccounts('codex').find((a) => a.id === id)!)
    })
  })
}

// --- Claude accounts signed in fully, each in a config folder of its own -------

function claudeConfigRoot(): string {
  return join(process.env.COVE_USER_DATA || app.getPath('userData'), 'claude-accounts')
}

/**
 * What in ~/.claude belongs to one account and is never linked into another's
 * folder. Read from Claude Code 2.1.314, which keeps here (with
 * CLAUDE_CONFIG_DIR set, in that folder instead):
 *  - .credentials.json: the login itself when the Keychain cannot be used;
 *  - .claude.json / .config.json (and the -staging/-local/-custom-oauth
 *    variants): the global config, holding oauthAccount, the userID and the
 *    account's cached feature flags; backups/ holds copies of it;
 *  - .storage-write: the lock round writes to that account's credentials;
 *  - policy-limits.json, remote-settings.json (and their .signature/.stamp
 *    files), teams/: what the account's organisation set;
 *  - mcp-needs-auth-cache.json, mcp-discovery-cache: the account's own claude.ai
 *    connectors; statsig/, cache/ (the model list is per plan), state/,
 *    remote-control, remote, daemon, chrome, the locks and session tokens.
 * Everything else (settings, CLAUDE.md, skills, agents, commands, plugins,
 * hooks, projects/ with every transcript, history, todos) is shared, so a chat
 * resumes on any account and behaves the same on each.
 */
export const CLAUDE_NOT_SHARED = new Set([
  '.credentials.json',
  '.claude.json',
  '.claude.json.backup',
  '.config.json',
  '.storage-write',
  '.device-keys.json',
  '.session_ingress_token',
  'backups',
  'teams',
  'statsig',
  'cache',
  'state',
  'mcp-needs-auth-cache.json',
  'mcp-discovery-cache',
  'hfi-auth.json',
  'remote-control',
  'remote',
  'daemon',
  'chrome',
  'server-sessions.json',
  'usage-data',
  'stats-cache.json'
])

export function claudeEntryShared(name: string): boolean {
  if (CLAUDE_NOT_SHARED.has(name)) return false
  // The global config's per-environment twins, and the organisation's files
  // with their signatures and stamps.
  if (/^\.claude.*\.json/.test(name)) return false
  if (/^(policy-limits|remote-settings)\.json/.test(name)) return false
  if (name.endsWith('.lock')) return false
  return true
}

/**
 * Make `dir` a Claude config folder that shares everything with ~/.claude but
 * what belongs to an account (CLAUDE_NOT_SHARED): every other entry there is a
 * symlink. Safe to repeat; anything ~/.claude gained since is linked next time.
 * projects/ is made in ~/.claude first if it is missing, so the transcripts of
 * every account land in the one place.
 *
 * The global config file is not linked: it holds who is signed in, and
 * `claude auth login` writes it. The user's MCP servers in it are copied in
 * instead (syncClaudeGlobalConfig).
 */
export function linkClaudeConfigDir(
  dir: string,
  source = join(os.homedir(), '.claude'),
  globalConfig = join(os.homedir(), '.claude.json')
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (existsSync(source)) {
    try {
      mkdirSync(join(source, 'projects'), { recursive: true })
    } catch {
      // read-only or odd; the account then keeps its own
    }
    for (const entry of readdirSync(source)) {
      if (!claudeEntryShared(entry)) continue
      const target = join(dir, entry)
      if (existsSync(target)) continue
      try {
        symlinkSync(join(source, entry), target)
      } catch {
        // A file Claude Code already wrote here of its own; leave it.
      }
    }
  }
  syncClaudeGlobalConfig(dir, globalConfig)
}

/** The MCP settings Claude Code keeps per project in its global config. */
const PROJECT_MCP_KEYS = [
  'mcpServers',
  'enabledMcpjsonServers',
  'disabledMcpjsonServers',
  'enableAllProjectMcpServers'
] as const

/**
 * Copy the user's MCP servers from ~/.claude.json into the account's own
 * .claude.json: the user-level ones (`mcpServers`) and each project's
 * (`projects[path].mcpServers` and its .mcp.json approvals). ~/.claude.json
 * stays the one the user edits; the account's file keeps everything else of
 * its own (oauthAccount above all). Written only when something changed.
 */
export function syncClaudeGlobalConfig(dir: string, globalConfig: string): void {
  let main: Record<string, unknown>
  try {
    main = JSON.parse(readFileSync(globalConfig, 'utf8')) as Record<string, unknown>
  } catch {
    return
  }
  const mine = join(dir, '.claude.json')
  let own: Record<string, unknown> = {}
  let before = ''
  try {
    before = readFileSync(mine, 'utf8')
    own = JSON.parse(before) as Record<string, unknown>
  } catch {
    if (before) return // there, but half-written: never overwrite what we cannot read
  }
  const next: Record<string, unknown> = { ...own }
  if (main.mcpServers && typeof main.mcpServers === 'object') next.mcpServers = main.mcpServers
  else delete next.mcpServers
  const mainProjects = (main.projects ?? {}) as Record<string, Record<string, unknown>>
  if (mainProjects && typeof mainProjects === 'object') {
    const projects = { ...((own.projects ?? {}) as Record<string, Record<string, unknown>>) }
    for (const [path, p] of Object.entries(mainProjects)) {
      if (!p || typeof p !== 'object') continue
      const picked = Object.fromEntries(
        PROJECT_MCP_KEYS.filter((k) => p[k] !== undefined).map((k) => [k, p[k]])
      )
      if (!Object.keys(picked).length && !projects[path]) continue
      projects[path] = { ...projects[path], ...picked }
    }
    next.projects = projects
  }
  const text = JSON.stringify(next, null, 2)
  if (before && JSON.stringify(own, null, 2) === text) return
  const tmp = `${mine}.superagent-${process.pid}`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, mine)
}

/**
 * The Keychain item Claude Code keeps a config folder's login in. Read from
 * 2.1.314: "Claude Code-credentials", and with CLAUDE_CONFIG_DIR set, "-" and
 * the first 8 hex characters of the SHA-256 of that path exactly as given
 * (NFC), not resolved. The item's account is $USER.
 */
export function claudeCredentialService(configDir: string): string {
  const hash = createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)
  return `Claude Code-credentials-${hash}`
}

/** $USER as Claude Code names the Keychain item's account. */
function keychainAccount(): string {
  let user: string
  try {
    user = process.env.USER || os.userInfo().username
  } catch {
    user = 'claude-code-user'
  }
  return /^[a-zA-Z0-9._-]+$/.test(user) ? user : 'claude-code-user'
}

/** The Keychain as accounts.ts uses it; a fake in tests. */
export interface Keychain {
  read(service: string, account: string): Promise<string>
  remove(service: string, account: string): Promise<void>
}

/** The real one; a test instance of the app never opens it (see liveUsage). */
const realKeychain: Keychain = {
  read: async (service, account) =>
    liveUsage()
      ? run('/usr/bin/security', ['find-generic-password', '-a', account, '-s', service, '-w'])
      : '',
  remove: async (service, account) => {
    // Never the main login's item: only an account folder's has a suffix.
    if (!liveUsage() || service === 'Claude Code-credentials') return
    await run('/usr/bin/security', ['delete-generic-password', '-a', account, '-s', service])
  }
}
let keychain: Keychain = realKeychain

/** Tests: a Keychain of their own. */
export function _setKeychainForTests(k: Keychain | null): void {
  keychain = k ?? realKeychain
}

/**
 * The access token in a stored Claude login, while it is still good. Claude
 * Code writes it as JSON, which `security -w` prints as is, or as hex when it
 * would not print.
 */
export function accessTokenFrom(raw: string, now = Date.now()): string | null {
  let text = raw.trim()
  if (!text) return null
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0)
    text = Buffer.from(text, 'hex').toString('utf8')
  try {
    const o = (JSON.parse(text) as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } })
      .claudeAiOauth
    if (!o?.accessToken) return null
    if (o.expiresAt && o.expiresAt < now + 60_000) return null
    return o.accessToken
  } catch {
    return null
  }
}

/**
 * The access token of an account signed in in its own config folder: its
 * Keychain item, else the .credentials.json Claude Code falls back to. Like
 * the main login's, never refreshed from here: refreshing hands out a new
 * refresh token and the one Claude Code holds would stop working.
 */
export async function claudeConfigToken(configDir: string): Promise<string | null> {
  const fromKeychain = accessTokenFrom(
    await keychain.read(claudeCredentialService(configDir), keychainAccount()).catch(() => '')
  )
  if (fromKeychain) return fromKeychain
  try {
    return accessTokenFrom(readFileSync(join(configDir, '.credentials.json'), 'utf8'))
  } catch {
    return null
  }
}

/** How a sign-in is run: agent-signin.ts in the app, a fake in tests. */
export type ClaudeSignIn = (
  env: Record<string, string>,
  partition: string
) => Promise<{ ok: true } | { ok: false; cancelled?: boolean; error: string }>
/** Who a config folder is signed in as: `claude auth status` in the app. */
export type ClaudeWhoAmI = (env: Record<string, string>) => Promise<LoginState | null>

/**
 * Sign another Claude account in fully: `claude auth login` with a config
 * folder of its own, in Superagent's sign-in window. Named after who signed in
 * ("campaigns@songpush.com · Max plan") unless a name was given.
 *
 * With `replaces`, a token account of the same person is swapped for it: its
 * chats move to the new one, as does its place as the default, and the token
 * is forgotten. Nothing is left behind when the sign-in does not finish.
 */
export async function addClaudeLogin(
  name: string,
  signIn: ClaudeSignIn,
  whoAmI: ClaudeWhoAmI,
  replaces?: string
): Promise<Account> {
  const id = `claude:${randomUUID()}`
  const configDir = join(claudeConfigRoot(), id.replace(':', '-'))
  const env = { CLAUDE_CONFIG_DIR: configDir }
  // A jar of its own, new and empty: the main one is signed in to claude.ai as
  // the main account and would hand that one straight back.
  const partition = `persist:claude-${id.slice('claude:'.length)}`
  const forget = async (): Promise<void> => {
    await keychain.remove(claudeCredentialService(configDir), keychainAccount()).catch(() => {})
    clearJar(partition)
    try {
      rmSync(configDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
  try {
    linkClaudeConfigDir(configDir)
    const res = await signIn(env, partition)
    if (!res.ok) throw new Error(res.error)
    const who = await whoAmI(env)
    if (!who?.signedIn) throw new Error('Claude did not finish signing in. Try again.')
    const email = who.detail.split(' · ')[0]
    const main = logins.claude
    if (email && main?.signedIn && main.detail.split(' · ')[0] === email)
      throw new Error(`${email} is already your Claude login.`)
    const f = load()
    if (email && f.accounts.some((a) => a.kind === 'config' && a.who?.split(' · ')[0] === email))
      throw new Error(`${email} is already added.`)
    const old = replaces ? f.accounts.find((a) => a.id === replaces) : undefined
    f.accounts.push({
      id,
      provider: 'claude',
      name: name.trim() || old?.name || email || 'Claude account',
      kind: 'config',
      addedAt: Date.now(),
      configDir,
      who: who.detail,
      partition
    })
    if (old) moveAccount(old.id, id)
    save()
    broadcastToWindows('accounts:changed')
    return listAccounts('claude').find((a) => a.id === id)!
  } catch (e) {
    await forget()
    throw e
  }
}

/**
 * Hand everything of one account to another (a token account signed in fully):
 * the chats on it, its place as the default, then forget it.
 */
function moveAccount(from: string, to: string): void {
  const f = load()
  for (const [chatId, acct] of Object.entries(f.chats)) if (acct === from) f.chats[chatId] = to
  for (const p of Object.keys(f.defaults) as AgentProvider[])
    if (f.defaults[p] === from) f.defaults[p] = to
  f.accounts = f.accounts.filter((a) => a.id !== from)
  delete f.limits[from]
  delete f.auth[from]
  delete f.usage[from]
}

export function removeAccount(id: string): void {
  const f = load()
  const stored = f.accounts.find((a) => a.id === id)
  if (!stored) return
  f.accounts = f.accounts.filter((a) => a.id !== id)
  delete f.limits[id]
  for (const [chatId, acct] of Object.entries(f.chats)) if (acct === id) delete f.chats[chatId]
  if (f.defaults[stored.provider] === id) delete f.defaults[stored.provider]
  // The folder holds symlinks into ~/.codex or ~/.claude: rm removes the links,
  // never what they point at.
  for (const folder of [stored.home, stored.configDir]) {
    if (!folder) continue
    try {
      rmSync(folder, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
  if (stored.configDir)
    void keychain
      .remove(claudeCredentialService(stored.configDir), keychainAccount())
      .catch(() => {})
  if (stored.partition) clearJar(stored.partition)
  save()
}

/** Sign an account's sign-in window out of everything: its cookies go with it. */
function clearJar(partition: string): void {
  try {
    void session?.fromPartition(partition).clearStorageData()
  } catch {
    // no session to clear (tests), or already gone
  }
}

// --- the CLIs' own logins, by name -----------------------------------------------

/** "campaigns@songpush.com · Max" from `claude auth status`; signedIn false when it says so. */
export function probeClaudeLogin(env?: Record<string, string>): Promise<LoginState | null> {
  return new Promise((resolve) => {
    let out = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(findClaude(), ['auth', 'status'], {
        cwd: os.homedir(),
        shell: false,
        ...(env ? { env: withAccountEnv(agentEnv(findClaude()), env) } : {})
      })
    } catch {
      return resolve(null)
    }
    const timer = setTimeout(() => {
      proc.kill()
      resolve(null)
    }, 15_000)
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.on('error', () => resolve(null))
    proc.on('exit', () => {
      clearTimeout(timer)
      try {
        const j = JSON.parse(out) as {
          email?: string
          subscriptionType?: string
          loggedIn?: boolean
        }
        if (!j.loggedIn) return resolve({ detail: '', signedIn: false })
        const plan = j.subscriptionType
          ? `${j.subscriptionType[0].toUpperCase()}${j.subscriptionType.slice(1)} plan`
          : ''
        resolve({ detail: [j.email, plan].filter(Boolean).join(' · '), signedIn: true })
      } catch {
        resolve(null)
      }
    })
  })
}

/** "Logged in using ChatGPT" from `codex login status`; signedIn false on "Not logged in". */
function probeCodexLogin(): Promise<LoginState | null> {
  return new Promise((resolve) => {
    let out = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(findCodex(), ['login', 'status'], {
        cwd: os.homedir(),
        env: agentEnv(findCodex()),
        shell: false
      })
    } catch {
      return resolve(null)
    }
    const timer = setTimeout(() => {
      proc.kill()
      resolve(null)
    }, 15_000)
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.stderr?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.on('error', () => resolve(null))
    proc.on('exit', () => {
      clearTimeout(timer)
      const line = out.trim().split('\n')[0]?.trim() ?? ''
      if (/not logged in/i.test(line)) return resolve({ detail: '', signedIn: false })
      if (/logged in/i.test(line))
        return resolve({ detail: line.replace(/^Logged in (using|with) /i, ''), signedIn: true })
      resolve(null)
    })
  })
}

/**
 * Antigravity has no "who am I" command, but `agy models` only answers for a
 * signed-in account: a list on stdout, or "Please sign in" and a non-zero exit.
 */
function probeAntigravityLogin(): Promise<LoginState | null> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(findAgy(), ['models'], {
        cwd: os.homedir(),
        env: agentEnv(findAgy()),
        shell: false
      })
    } catch {
      return resolve(null)
    }
    const timer = setTimeout(() => {
      proc.kill()
      resolve(null)
    }, 15_000)
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.stderr?.on('data', (c: Buffer) => (err += c.toString('utf8')))
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (/sign in|not logged in|authenticat/i.test(err))
        return resolve({ detail: '', signedIn: false })
      if (code === 0 && out.trim()) return resolve({ detail: 'Google account', signedIn: true })
      resolve(null)
    })
  })
}

let probed: Promise<void> | null = null
/**
 * Ask each CLI who it is signed in as — once, or again with `force`.
 *
 * Each answer is kept, and the windows told, as it lands. The three are not
 * equally quick: `claude auth status` answers in a tenth of a second and
 * `agy models` can take six, and waiting for all of them kept every account
 * off the screen until the slowest agent had spoken.
 */
export function probeLogins(force = false): Promise<void> {
  if (!probed || force) {
    const land =
      (provider: AgentProvider) =>
      (state: LoginState | null): void => {
        if (!state) return
        logins[provider] = state
        broadcastToWindows('accounts:changed')
      }
    probed = Promise.all([
      probeClaudeLogin().then(land('claude')),
      probeCodexLogin().then(land('codex')),
      probeAntigravityLogin().then(land('antigravity'))
    ]).then(() => undefined)
  }
  return probed
}

// --- how much of each allowance is used ----------------------------------------

/**
 * Remember what an account last said about its allowance. Called from every
 * Claude turn and every Codex rate-limit update, so it only tells the windows
 * when a number they would show has moved.
 */
export function recordUsage(accountId: string, usage: Usage): void {
  const f = load()
  const before = f.usage[accountId]
  // A model's own window is only reported on a turn of that model (Fable's
  // comes back on a Fable request), so a turn on another model would wipe it.
  // Keep it until it starts over or is read again.
  const kept = (before?.windows ?? []).filter(
    (w) =>
      w.model &&
      (!w.resetsAt || w.resetsAt > usage.at) &&
      !usage.windows.some((n) => n.label === w.label)
  )
  if (kept.length) usage = { ...usage, windows: [...usage.windows, ...kept] }
  f.usage[accountId] = usage
  // Fresh numbers with every allowance below its limit: whatever mark says the
  // account is out is stale. A mark that outlived its reason (set to the
  // weekly reset when only the 5-hour window had run out) kept the account
  // unpickable for days with 0% of its 5-hour allowance used. A model's own
  // week does not count: running that out moves a chat to another model.
  const counted = usage.windows.filter((w) => !w.model)
  if (f.limits[accountId] && counted.length > 0 && counted.every((w) => w.percent < 100)) {
    delete f.limits[accountId]
    broadcastToWindows('accounts:changed')
  }
  save()
  const shown = (u: Usage | undefined): string =>
    JSON.stringify(u?.windows.map((w) => [w.label, w.percent, w.resetsAt]) ?? null)
  if (shown(before) !== shown(usage)) broadcastToWindows('accounts:changed')
}

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout.trim()))
  )

/**
 * The access token of Claude's own login, as Claude Code keeps it in the
 * keychain. Only while it is still good: it is never refreshed from here —
 * refreshing hands out a new refresh token, and the one Claude Code holds
 * would stop working, which signs it out.
 */
async function claudeLoginToken(): Promise<string | null> {
  if (!liveUsage()) return null
  const raw = await run('/usr/bin/security', [
    'find-generic-password',
    '-s',
    'Claude Code-credentials',
    '-w'
  ])
  return accessTokenFrom(raw)
}

/** Which windows Anthropic last named for each account, to log only a change. */
const reportedWindows = new Map<string, string>()

/**
 * Note in the app's log which usage windows Anthropic sent for an account (their
 * names only, never a token or a number), once per change. Some accounts come
 * back with no 5-hour window at all; this is how to tell why from the outside.
 */
function noteWindows(who: string, source: string, body: unknown): void {
  if (!body || typeof body !== 'object') return
  const named = Object.entries(body as Record<string, unknown>)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k]) => k)
    .sort()
    .join(',')
  const line = `${source}: ${named || '(nothing)'}`
  if (reportedWindows.get(who) === line) return
  reportedWindows.set(who, line)
  healthLog(`usage windows ${who} ${line}`)
}

/** Ask Anthropic what `/usage` would say for this token; null if it will not. */
async function claudeUsage(token: string, who = 'claude:login'): Promise<Usage | null> {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000)
    })
    // A setup-token may not be allowed to ask: its numbers come from its turns.
    if (!res.ok) {
      noteWindows(who, `oauth/usage ${res.status}`, {})
      return null
    }
    const body: unknown = await res.json()
    noteWindows(who, 'oauth/usage', body)
    return usageFromClaudeApi(body)
  } catch {
    return null
  }
}

/** How old a token account's numbers may be before it is asked again. */
const PROBE_EVERY_MS = 10 * 60_000

/**
 * A token from `claude setup-token` may run the model and nothing else, so it
 * cannot be asked for its usage — but every answer says it in its headers. One
 * message, one token out: a few dozen tokens of the
 * account's allowance, which is why it is only done when the numbers are
 * missing or old. An account that is out answers 429 with the same headers.
 */
async function claudeUsageByMessage(token: string): Promise<Usage | null> {
  // Asked on Fable first: its answer carries Fable's own week as well as the
  // account's. A plan without Fable, or an answer with no numbers, asks Haiku.
  for (const model of ['claude-fable-5-1', 'claude-haiku-4-5-20251001']) {
    const u = await claudeUsageAsking(token, model)
    if (u) return u
  }
  return null
}

async function claudeUsageAsking(token: string, model: string): Promise<Usage | null> {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages?beta=true', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        max_tokens: 1,
        // What a subscription token is for; without it the request is refused.
        system: [
          { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }
        ],
        messages: [{ role: 'user', content: 'hi' }]
      }),
      signal: AbortSignal.timeout(15_000)
    })
    return usageFromClaudeHeaders((name) => res.headers.get(name))
  } catch {
    return null
  }
}

/** Antigravity's own /usage, as JSON. No model call, so free to ask. */
function antigravityUsage(): Promise<Usage | null> {
  return new Promise((resolve) => {
    let out = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(findAgy(), ['-p', '/usage', '--output-format', 'json'], {
        cwd: os.homedir(),
        env: agentEnv(findAgy()),
        shell: false
      })
    } catch {
      return resolve(null)
    }
    const timer = setTimeout(() => {
      proc.kill()
      resolve(null)
    }, 20_000)
    proc.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')))
    proc.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
    proc.on('exit', () => {
      clearTimeout(timer)
      try {
        resolve(usageFromAntigravity(JSON.parse(out)))
      } catch {
        resolve(null)
      }
    })
  })
}

/** Ask a Codex account's own server, briefly, for its rate limits. */
async function codexUsage(env: Record<string, string>): Promise<Usage | null> {
  const client = new CodexClient({ ...process.env, ...env })
  const timer = setTimeout(() => client.stop(), 15_000)
  try {
    await client.start(app.getVersion())
    const res = await client.request('account/rateLimits/read', {})
    return usageFromCodex(res.rateLimits)
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    client.stop()
  }
}

let usageRead: { at: number; done: Promise<void> } | null = null

/** A test instance never reads the real keychain or starts the real Codex,
 *  unless it asks to (COVE_E2E_USAGE=1, to see the real numbers). */
const liveUsage = (): boolean => !process.env.COVE_USER_DATA || process.env.COVE_E2E_USAGE === '1'

/**
 * Read every account's allowance now, where it can be asked: Claude's login,
 * any Claude token Anthropic will answer for, and every Codex account. At most
 * once a minute; Settings asks on opening.
 */
export function refreshUsage(force = false): Promise<void> {
  if (usageRead && !force && Date.now() - usageRead.at < 60_000) return usageRead.done
  const jobs: Promise<void>[] = []
  const put = (id: string, u: Usage | null): void => {
    if (u) recordUsage(id, u)
  }
  jobs.push(
    claudeLoginToken().then(async (t) => put(LOGIN_ID.claude, t ? await claudeUsage(t) : null))
  )
  for (const a of load().accounts) {
    if (a.provider === 'claude' && a.kind === 'token' && a.token && liveUsage()) {
      const token = decrypt(a.token)
      const known = load().usage[a.id]
      const fresh = known && Date.now() - known.at < PROBE_EVERY_MS
      jobs.push(
        claudeUsage(token, a.id).then(async (u) =>
          put(a.id, u ?? (fresh ? null : await claudeUsageByMessage(token)))
        )
      )
    }
    // A full login may ask for its usage, as the main one does.
    if (a.provider === 'claude' && a.kind === 'config' && a.configDir && liveUsage()) {
      const dir = a.configDir
      jobs.push(
        claudeConfigToken(dir).then(async (t) => put(a.id, t ? await claudeUsage(t, a.id) : null))
      )
    }
  }
  if (logins.antigravity?.signedIn !== false && liveUsage())
    jobs.push(antigravityUsage().then((u) => put(LOGIN_ID.antigravity, u)))
  if (logins.codex?.signedIn !== false && liveUsage()) {
    jobs.push(codexUsage({}).then((u) => put(LOGIN_ID.codex, u)))
    for (const a of load().accounts.filter((x) => x.provider === 'codex' && x.home))
      jobs.push(codexUsage(accountEnv(a.id)).then((u) => put(a.id, u)))
  }
  const done = Promise.all(jobs).then(() => undefined)
  usageRead = { at: Date.now(), done }
  return done
}

export function registerAccountsIpc(): void {
  ipcMain.handle('accounts:list', async (_e, recheck?: boolean) => {
    // Asked to re-check, the answer waits for the checks. Otherwise the list
    // goes back at once — a login not heard from yet says "Checking…" — and
    // each check announces itself when it lands (see probeLogins).
    const probing = probeLogins(recheck === true)
    if (recheck === true) await probing
    return {
      claude: listAccounts('claude'),
      codex: listAccounts('codex'),
      antigravity: listAccounts('antigravity'),
      mode: limitMode()
    }
  })
  // Settings opening: read the allowances, then the list says what they are.
  ipcMain.handle('accounts:refresh-usage', (_e, force?: boolean) => refreshUsage(force === true))
  ipcMain.handle('accounts:add-claude', (_e, name: string, token: string) =>
    addClaudeToken(name, token)
  )
  ipcMain.handle('accounts:add-codex', (_e, name: string) => addCodexAccount(name))
  // Another Claude account, signed in fully in Superagent's sign-in window; or
  // a token account of the same person signed in fully (`replaces`).
  ipcMain.handle('accounts:add-claude-login', (e, name: string, replaces?: string) =>
    addClaudeLogin(
      name,
      (env, partition) =>
        signInAgent('claude', BrowserWindow.fromWebContents(e.sender), { env, partition }),
      (env) => probeClaudeLogin(env),
      replaces
    )
  )
  ipcMain.handle('accounts:set-default', (_e, provider: AgentProvider, id: string) =>
    setDefaultAccount(provider, id)
  )
  ipcMain.handle('accounts:remove', (_e, id: string) => removeAccount(id))
  ipcMain.handle('accounts:set-mode', (_e, mode: LimitMode) => setLimitMode(mode))
  ipcMain.handle('accounts:switch', (_e, chatId: string, id: string) => {
    pinChatAccount(chatId, id)
    // The chat's Account pill says which one it is on.
    broadcastToWindows('accounts:changed')
  })
  ipcMain.handle('accounts:for-chat', (_e, provider: AgentProvider, chatId: string) =>
    accountForChat(provider, chatId)
  )
  // Picked by hand from the chat's Account pill: the chat goes to it, and a
  // pick is announced like any other change so every pill redraws.
  ipcMain.handle('accounts:pick', (_e, chatId: string, id: string) => {
    pinChatAccount(chatId, id)
    // Picked by hand: the chat goes to it. A mark saying the account is out
    // used to override the pick in silence (accountForChat skips a limited
    // account), so the click did nothing. If it really is out, the CLI says
    // so on the next turn and the usual move to another account follows.
    clearLimit(id)
    broadcastToWindows('accounts:changed')
  })
}

/** What connectors.ts needs to know of a Claude account: where it lives. */
export function claudeAccountPlace(
  accountId: string
): { kind: AccountKind; configDir?: string; partition?: string } | null {
  if (accountId === LOGIN_ID.claude) return { kind: 'login', partition: 'persist:agent-signin' }
  const a = load().accounts.find((x) => x.id === accountId && x.provider === 'claude')
  return a ? { kind: a.kind, configDir: a.configDir, partition: a.partition } : null
}

/** A Claude account's access token, where one can be read (login and config). */
export async function claudeAccountToken(accountId: string): Promise<string | null> {
  const place = claudeAccountPlace(accountId)
  if (!place) return null
  if (place.kind === 'login') return claudeLoginToken()
  if (place.kind === 'config' && place.configDir && liveUsage())
    return claudeConfigToken(place.configDir)
  return null
}

/** Tests: forget the cached file so the next call re-reads it. */
export function _resetAccountsForTests(): void {
  file = null
}
