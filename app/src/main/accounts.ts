import { app, ipcMain, safeStorage } from 'electron'
import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import os from 'os'
import { join } from 'path'
import { findAgy, findClaude, findCodex } from './claude-cli'
import { broadcastToWindows } from './util'
import type { AgentProvider } from '../shared/agent-provider'

/**
 * More than one subscription per agent, so a chat can carry on when one hits
 * its limit.
 *
 * Each CLI keeps one login of its own — the "login" account below, which is
 * whatever `claude auth login` / `codex login` set up and needs nothing from
 * us. Extra accounts ride on top without disturbing it:
 *
 *  - Claude: a long-lived token from `claude setup-token`, handed to the CLI as
 *    CLAUDE_CODE_OAUTH_TOKEN. Verified against 2.1.283: the env var wins over
 *    the Keychain login, and the config folder (settings, skills, session
 *    transcripts) stays shared — so a conversation resumes across accounts.
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
  /** The CLI's own login, an extra Claude token, or an extra Codex home. */
  kind: 'login' | 'token' | 'home'
  /** Epoch ms until which this account is known to be out of allowance. */
  limitedUntil: number | null
  /** Who it is: "campaigns@songpush.com · Max" for a login; when a token was added. */
  detail: string
  /**
   * The CLI refused this account's credentials (a revoked token, a logged-out
   * CLI): the one-line reason, until a session starts on it again.
   */
  needsAuth: string | null
}

/** Extra accounts, as written to disk. Tokens are stored encrypted. */
interface StoredAccount {
  id: string
  provider: AgentProvider
  name: string
  kind: 'token' | 'home'
  addedAt?: number
  /** base64 of the safeStorage-encrypted token (Claude). */
  token?: string
  /** CODEX_HOME folder (Codex). */
  home?: string
}

export type LimitMode = 'ask' | 'auto'

interface AccountsFile {
  accounts: StoredAccount[]
  mode: LimitMode
  limits: Record<string, number>
  chats: Record<string, string>
  /** Accounts whose credentials the CLI last refused, with its reason. */
  auth: Record<string, string>
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
      auth: raw.auth && typeof raw.auth === 'object' ? raw.auth : {}
    }
  } catch {
    file = { accounts: [], mode: 'ask', limits: {}, chats: {}, auth: {} }
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
  const login: Account = {
    id: LOGIN_ID[provider],
    provider,
    name: LOGIN_NAME[provider],
    kind: 'login',
    limitedUntil: limitedUntil(LOGIN_ID[provider]),
    detail: state ? (state.signedIn ? state.detail : '') : 'Checking…',
    needsAuth:
      state && !state.signedIn ? SIGN_IN_HINT[provider] : (f.auth[LOGIN_ID[provider]] ?? null)
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
          (a.kind === 'token' ? 'Token' : 'Signed in') +
          (a.addedAt ? ` · added ${new Date(a.addedAt).toLocaleDateString()}` : ''),
        needsAuth: f.auth[a.id] ?? null
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

/** Which account a chat runs on: its own pick, else the first with allowance left. */
export function accountForChat(provider: AgentProvider, chatId: string | undefined): Account {
  const all = listAccounts(provider)
  const pinned = chatId ? all.find((a) => a.id === load().chats[chatId]) : undefined
  if (pinned && !pinned.limitedUntil) return pinned
  return all.find((a) => !a.limitedUntil) ?? pinned ?? all[0]
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
  return {}
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
  seven_day_sonnet: 'sonnet'
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
      env: { ...process.env, CODEX_HOME: home },
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

export function removeAccount(id: string): void {
  const f = load()
  const stored = f.accounts.find((a) => a.id === id)
  if (!stored) return
  f.accounts = f.accounts.filter((a) => a.id !== id)
  delete f.limits[id]
  for (const [chatId, acct] of Object.entries(f.chats)) if (acct === id) delete f.chats[chatId]
  if (stored.home) {
    try {
      rmSync(stored.home, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
  save()
}

// --- the CLIs' own logins, by name -----------------------------------------------

/** "campaigns@songpush.com · Max" from `claude auth status`; signedIn false when it says so. */
function probeClaudeLogin(): Promise<LoginState | null> {
  return new Promise((resolve) => {
    let out = ''
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(findClaude(), ['auth', 'status'], { cwd: os.homedir(), shell: false })
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
      proc = spawn(findCodex(), ['login', 'status'], { cwd: os.homedir(), shell: false })
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
      proc = spawn(findAgy(), ['models'], { cwd: os.homedir(), shell: false })
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
      if (/sign in|not logged in|authenticat/i.test(err)) return resolve({ detail: '', signedIn: false })
      if (code === 0 && out.trim()) return resolve({ detail: 'Google account', signedIn: true })
      resolve(null)
    })
  })
}

let probed: Promise<void> | null = null
/** Ask each CLI who it is signed in as — once, or again with `force`. */
export function probeLogins(force = false): Promise<void> {
  if (!probed || force)
    probed = Promise.all([probeClaudeLogin(), probeCodexLogin(), probeAntigravityLogin()]).then(
      ([c, x, g]) => {
        if (c) logins.claude = c
        if (x) logins.codex = x
        if (g) logins.antigravity = g
      }
    )
  return probed
}

export function registerAccountsIpc(): void {
  ipcMain.handle('accounts:list', async (_e, recheck?: boolean) => {
    await probeLogins(recheck === true)
    return {
      claude: listAccounts('claude'),
      codex: listAccounts('codex'),
      antigravity: listAccounts('antigravity'),
      mode: limitMode()
    }
  })
  ipcMain.handle('accounts:add-claude', (_e, name: string, token: string) =>
    addClaudeToken(name, token)
  )
  ipcMain.handle('accounts:add-codex', (_e, name: string) => addCodexAccount(name))
  ipcMain.handle('accounts:remove', (_e, id: string) => removeAccount(id))
  ipcMain.handle('accounts:set-mode', (_e, mode: LimitMode) => setLimitMode(mode))
  ipcMain.handle('accounts:switch', (_e, chatId: string, id: string) => pinChatAccount(chatId, id))
  ipcMain.handle('accounts:for-chat', (_e, provider: AgentProvider, chatId: string) =>
    accountForChat(provider, chatId)
  )
}

/** Tests: forget the cached file so the next call re-reads it. */
export function _resetAccountsForTests(): void {
  file = null
}
