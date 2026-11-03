import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  readFileSync,
  existsSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ broadcasts: [] as { ch: string; p: unknown }[] }))

vi.mock('electron', () => ({
  app: { getPath: () => process.env.COVE_USER_DATA },
  BrowserWindow: { fromWebContents: () => null },
  ipcMain: { handle: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))
vi.mock('./util', () => ({
  broadcastToWindows: (ch: string, p: unknown) => h.broadcasts.push({ ch, p })
}))
vi.mock('./claude-cli', () => ({
  findClaude: () => 'claude',
  findCodex: () => 'codex',
  agentEnv: (_b: string, env = process.env) => env
}))
vi.mock('./agent-signin', () => ({ signInAgent: vi.fn() }))

import {
  _resetAccountsForTests,
  _setKeychainForTests,
  accessTokenFrom,
  accountEnv,
  accountForChat,
  addClaudeLogin,
  addClaudeToken,
  claudeConfigToken,
  claudeCredentialService,
  CLAUDE_NOT_SHARED,
  linkClaudeConfigDir,
  setDefaultAccount,
  syncClaudeGlobalConfig,
  withAccountEnv,
  authFailureFrom,
  authFailureFromEvent,
  DEFAULT_LIMIT_MS,
  epochMs,
  limitFromCodexRateLimits,
  LimitGate,
  limitFromEvent,
  linkCodexHome,
  listAccounts,
  LOGIN_ID,
  markAuth,
  markLimited,
  markModelLimited,
  modelLimitedUntil,
  pinChatAccount,
  removeAccount,
  recordUsage,
  reportLimit,
  setLimitMode
} from './accounts'

let dir: string
const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40)
const realHome = process.env.HOME
/** The Keychain as the tests see it: service → stored text, and what was removed. */
const kc = { items: new Map<string, string>(), removed: [] as string[] }

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cove-accounts-'))
  process.env.COVE_USER_DATA = dir
  // Never the user's own ~/.claude or ~/.claude.json: os.homedir() reads HOME.
  process.env.HOME = join(dir, 'home')
  mkdirSync(process.env.HOME, { recursive: true })
  h.broadcasts.length = 0
  kc.items.clear()
  kc.removed.length = 0
  _setKeychainForTests({
    read: async (service) => kc.items.get(service) ?? '',
    remove: async (service) => {
      kc.removed.push(service)
      kc.items.delete(service)
    }
  })
  _resetAccountsForTests()
})
afterEach(() => {
  process.env.HOME = realHome
  _setKeychainForTests(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('what the CLIs say when an account runs dry', () => {
  it("reads Claude's rate_limit_event, reset time in epoch seconds", () => {
    expect(
      limitFromEvent({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000, rateLimitType: 'five_hour' }
      })
    ).toEqual({ until: 1_800_000_000_000 })
    expect(
      limitFromEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })
    ).toBeNull()
  })

  it('reads the reason off a failed result, from either CLI', () => {
    expect(
      limitFromEvent({
        type: 'result',
        is_error: true,
        result: "You've hit your limit · resets 3pm"
      })
    ).toEqual({ until: null })
    expect(
      limitFromEvent({
        type: 'result',
        is_error: true,
        result: 'usage limit reached for this plan'
      })
    ).toEqual({ until: null })
    expect(
      limitFromEvent({ type: 'result', is_error: true, result: 'stream disconnected' })
    ).toBeNull()
    expect(limitFromEvent({ type: 'result', is_error: false })).toBeNull()
  })

  it("reads Codex's account/rateLimits/updated", () => {
    expect(
      limitFromCodexRateLimits({
        rateLimits: {
          primary: { usedPercent: 100, resetsAt: 1_800_000_000 },
          secondary: { usedPercent: 40 }
        }
      })
    ).toEqual({ until: 1_800_000_000_000 })
    expect(limitFromCodexRateLimits({ rateLimits: { primary: { usedPercent: 99 } } })).toBeNull()
    expect(limitFromCodexRateLimits({})).toBeNull()
  })

  it('tells refused credentials apart from an exhausted account', () => {
    expect(authFailureFrom('Invalid API key · Please run /login')).toMatch(/Invalid API key/)
    expect(authFailureFrom('OAuth token expired. Sign in again.')).toMatch(/OAuth token expired/)
    expect(authFailureFrom("You've hit your limit")).toBeNull()
    expect(
      authFailureFromEvent({
        type: 'result',
        is_error: true,
        result: 'authentication_error: bad token'
      })
    ).toMatch(/authentication_error/)
    expect(authFailureFromEvent({ type: 'assistant' })).toBeNull()
  })

  it('takes seconds or milliseconds since the epoch', () => {
    expect(epochMs(1_800_000_000)).toBe(1_800_000_000_000)
    expect(epochMs(1_800_000_000_000)).toBe(1_800_000_000_000)
    expect(epochMs('soon')).toBeNull()
  })
})

describe('accounts', () => {
  it("starts with the CLI's own login and nothing else", () => {
    expect(listAccounts('claude').map((a) => a.id)).toEqual([LOGIN_ID.claude])
    expect(accountForChat('claude', 'c1').id).toBe(LOGIN_ID.claude)
    expect(accountEnv(LOGIN_ID.claude)).toEqual({})
  })

  it('keeps a Claude token encrypted and hands it to the CLI as its env', () => {
    const acct = addClaudeToken('Work', ` ${TOKEN} `)
    expect(acct.kind).toBe('token')
    expect(acct.detail).toMatch(/^Token · added/)
    const onDisk = readFileSync(join(dir, 'accounts.json'), 'utf8')
    expect(onDisk).not.toContain(TOKEN)
    expect(accountEnv(acct.id)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    expect(() => addClaudeToken('Bad', 'sk-ant-api03-nope')).toThrow(/setup-token/)
  })

  it('a chat runs on its own pick until that one is out, then the next with allowance', () => {
    const work = addClaudeToken('Work', TOKEN)
    pinChatAccount('c1', work.id)
    expect(accountForChat('claude', 'c1').id).toBe(work.id)
    markLimited(work.id, Date.now() + 60_000)
    expect(accountForChat('claude', 'c1').id).toBe(LOGIN_ID.claude)
    // Every account out: stay put rather than pretend.
    markLimited(LOGIN_ID.claude, Date.now() + 60_000)
    expect(accountForChat('claude', 'c1').id).toBe(work.id)
    // A limit that has passed is forgotten.
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 61_000)
    expect(listAccounts('claude').find((a) => a.id === work.id)?.limitedUntil).toBeNull()
    vi.useRealTimers()
  })

  it('assumes the usual window when the CLI gave no reset time', () => {
    const before = Date.now()
    const at = markLimited(LOGIN_ID.claude, null)
    expect(at).toBeGreaterThanOrEqual(before + DEFAULT_LIMIT_MS)
  })

  it('in ask mode a limit tells the window and leaves the chat where it is', () => {
    const work = addClaudeToken('Work', TOKEN)
    const notice = reportLimit('c1', 'claude', LOGIN_ID.claude, null)
    expect(notice.switchedTo).toBeNull()
    expect(notice.alternatives).toEqual([{ id: work.id, name: 'Work' }])
    expect(h.broadcasts).toEqual([{ ch: 'accounts:limit', p: notice }])
    expect(accountForChat('claude', 'c1').id).toBe(work.id) // the fallback, not a pin
  })

  it('in auto mode it moves the chat and says which account it is on now', () => {
    const work = addClaudeToken('Work', TOKEN)
    setLimitMode('auto')
    const notice = reportLimit('c1', 'claude', LOGIN_ID.claude, 1_800_000_000_000)
    expect(notice.switchedTo).toEqual({ id: work.id, name: 'Work' })
    expect(notice.until).toBe(1_800_000_000_000)
    // Nothing to move to: the notice says so.
    const alone = reportLimit('c2', 'codex', LOGIN_ID.codex, null)
    expect(alone.switchedTo).toBeNull()
    expect(alone.alternatives).toEqual([])
  })

  it('remembers refused credentials until a session starts on the account again', () => {
    markAuth(LOGIN_ID.claude, 'OAuth token expired')
    expect(listAccounts('claude')[0].needsAuth).toBe('OAuth token expired')
    expect(h.broadcasts.map((b) => b.ch)).toEqual(['accounts:changed'])
    markAuth(LOGIN_ID.claude, null)
    expect(listAccounts('claude')[0].needsAuth).toBeNull()
  })

  it('a Codex home shares everything with ~/.codex but the login', () => {
    const source = join(dir, 'dot-codex')
    mkdirSync(join(source, 'sessions'), { recursive: true })
    writeFileSync(join(source, 'config.toml'), 'model = "x"\n')
    writeFileSync(join(source, 'auth.json'), '{"secret":true}')
    const home = join(dir, 'home-b')
    linkCodexHome(home, source)
    expect(lstatSync(join(home, 'config.toml')).isSymbolicLink()).toBe(true)
    expect(lstatSync(join(home, 'sessions')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    // Repeatable, and picks up what ~/.codex gained since.
    writeFileSync(join(source, 'skills'), '')
    linkCodexHome(home, source)
    expect(lstatSync(join(home, 'skills')).isSymbolicLink()).toBe(true)
  })

  it('removing an account forgets its pins and limits too', () => {
    const work = addClaudeToken('Work', TOKEN)
    pinChatAccount('c1', work.id)
    markLimited(work.id, Date.now() + 60_000)
    removeAccount(work.id)
    _resetAccountsForTests()
    expect(listAccounts('claude').map((a) => a.id)).toEqual([LOGIN_ID.claude])
    expect(accountForChat('claude', 'c1').id).toBe(LOGIN_ID.claude)
  })
})

describe('a reported limit waits for the turn to say whether it mattered', () => {
  it('a failed turn means the account is out', () => {
    const gate = new LimitGate()
    gate.hold({ until: 1_800_000_000_000 })
    gate.hold({ until: null }) // the result's own text, with no time
    expect(gate.result({ type: 'result', is_error: true })).toEqual({ until: 1_800_000_000_000 })
    // Spent: the next turn starts clean.
    expect(gate.result({ type: 'result', is_error: true })).toBeNull()
  })

  it('a fallback model carrying the turn on means it is not', () => {
    const gate = new LimitGate()
    gate.hold({ until: 1_800_000_000_000 })
    gate.fellBack()
    expect(gate.result({ type: 'result', is_error: false })).toBeNull()
  })

  it('nor is a turn that simply finished', () => {
    const gate = new LimitGate()
    gate.hold({ until: null })
    expect(gate.result({ type: 'result', is_error: false })).toBeNull()
    expect(gate.result({ type: 'result', is_error: true })).toBeNull()
  })
})

describe('one model out, not the account', () => {
  it("reads which model from the CLI's words and its limit type", () => {
    const words =
      "You've reached your Fable limit. Switch to another model, or manage usage credits at claude.ai/settings/usage to continue."
    expect(limitFromEvent({ type: 'result', is_error: true, result: words })).toEqual({
      until: null,
      model: 'fable'
    })
    expect(
      limitFromEvent({
        type: 'assistant',
        message: { model: '<synthetic>', content: [{ type: 'text', text: words }] }
      })
    ).toEqual({ until: null, model: 'fable' })
    // A real reply that happens to say the words is not a limit.
    expect(
      limitFromEvent({
        type: 'assistant',
        message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: words }] }
      })
    ).toBeNull()
    expect(
      limitFromEvent({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'rejected',
          resetsAt: 1_800_000_000,
          rateLimitType: 'seven_day_opus'
        }
      })
    ).toEqual({ until: 1_800_000_000_000, model: 'opus' })
  })

  it('keeps the reset time and the model, whichever arrives first', () => {
    const gate = new LimitGate()
    gate.hold({ until: 1_800_000_000_000 })
    gate.hold({ until: null, model: 'fable' })
    expect(gate.result({ type: 'result', is_error: true })).toEqual({
      until: 1_800_000_000_000,
      model: 'fable'
    })
  })

  it('is remembered until the reset', () => {
    expect(modelLimitedUntil('fable')).toBeNull()
    markModelLimited('fable', Date.now() + 60_000)
    expect(modelLimitedUntil('fable')).toBeGreaterThan(Date.now())
    expect(modelLimitedUntil('opus')).toBeNull()
    expect(modelLimitedUntil(null)).toBeNull()
  })
})

describe('usage', () => {
  it('is remembered per account, kept across a restart, and only announced when it moves', () => {
    addClaudeToken('Work', TOKEN)
    const work = listAccounts('claude')[1]
    expect(work.usage).toBeNull()
    const usage = { windows: [{ label: '5-hour', percent: 40, resetsAt: null }], at: 1 }
    h.broadcasts.length = 0
    recordUsage(work.id, usage)
    expect(h.broadcasts.map((b) => b.ch)).toEqual(['accounts:changed'])
    // The same numbers read again a minute later: nothing for the window to redraw.
    recordUsage(work.id, { ...usage, at: 2 })
    expect(h.broadcasts).toHaveLength(1)
    _resetAccountsForTests()
    expect(listAccounts('claude')[1].usage).toEqual({ ...usage, at: 2 })
    expect(listAccounts('claude')[0].usage).toBeNull()
  })
})

describe('a mark that outlived its reason', () => {
  it('goes when fresh usage shows every allowance below its limit', () => {
    const login = LOGIN_ID.claude
    markLimited(login, Date.now() + 3 * 24 * 3600_000)
    expect(listAccounts('claude')[0].limitedUntil).not.toBeNull()
    // 0% of the 5-hour window and 85% of the week: not out at all.
    recordUsage(login, {
      windows: [
        { label: '5-hour', percent: 0, resetsAt: Date.now() + 3600_000 },
        { label: 'Weekly', percent: 85, resetsAt: Date.now() + 3 * 24 * 3600_000 }
      ],
      at: Date.now()
    })
    expect(listAccounts('claude')[0].limitedUntil).toBeNull()
  })

  it('stays while one allowance really is used up', () => {
    const login = LOGIN_ID.claude
    markLimited(login, Date.now() + 3600_000)
    recordUsage(login, {
      windows: [{ label: '5-hour', percent: 100, resetsAt: Date.now() + 3600_000 }],
      at: Date.now()
    })
    expect(listAccounts('claude')[0].limitedUntil).not.toBeNull()
  })

  it('goes even with Fable’s own week used up, which only moves a chat to the next model', () => {
    const login = LOGIN_ID.claude
    markLimited(login, Date.now() + 3600_000)
    recordUsage(login, {
      windows: [
        { label: '5-hour', percent: 20, resetsAt: Date.now() + 3600_000 },
        { label: 'Weekly', percent: 89, resetsAt: Date.now() + 24 * 3600_000 },
        {
          label: 'Weekly Fable',
          percent: 100,
          resetsAt: Date.now() + 24 * 3600_000,
          model: 'fable'
        }
      ],
      at: Date.now()
    })
    expect(listAccounts('claude')[0].limitedUntil).toBeNull()
  })
})

describe('a model’s own week', () => {
  it('outlasts a turn on another model, which does not report it', () => {
    const login = LOGIN_ID.claude
    const week = Date.now() + 24 * 3600_000
    recordUsage(login, {
      windows: [
        { label: 'Weekly', percent: 80, resetsAt: week },
        { label: 'Weekly Fable', percent: 60, resetsAt: week, model: 'fable' }
      ],
      at: Date.now()
    })
    recordUsage(login, {
      windows: [{ label: 'Weekly', percent: 81, resetsAt: week }],
      at: Date.now()
    })
    expect(listAccounts('claude')[0].usage?.windows).toEqual([
      { label: 'Weekly', percent: 81, resetsAt: week },
      { label: 'Weekly Fable', percent: 60, resetsAt: week, model: 'fable' }
    ])
  })
})

/** A full Claude login, signed in through fakes: nothing real is run. */
async function signedIn(
  email = 'campaigns@songpush.com',
  name = '',
  replaces?: string
): Promise<{ id: string; env: Record<string, string>; partition: string }> {
  let env: Record<string, string> = {}
  let partition = ''
  const a = await addClaudeLogin(
    name,
    async (e, p) => {
      env = e
      partition = p
      return { ok: true }
    },
    async () => ({ detail: `${email} · Max plan`, signedIn: true }),
    replaces
  )
  return { id: a.id, env, partition }
}

describe('the env each kind of account runs with', () => {
  it('login: nothing; token: the token; Codex home: CODEX_HOME; full login: CLAUDE_CONFIG_DIR only', async () => {
    expect(accountEnv(LOGIN_ID.claude)).toEqual({})
    const token = addClaudeToken('Work', TOKEN)
    expect(accountEnv(token.id)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: TOKEN })
    const full = await signedIn()
    const env = accountEnv(full.id)
    expect(Object.keys(env)).toEqual(['CLAUDE_CONFIG_DIR'])
    expect(env.CLAUDE_CONFIG_DIR).toBe(full.env.CLAUDE_CONFIG_DIR)
    expect(env.CLAUDE_CONFIG_DIR.startsWith(join(dir, 'claude-accounts'))).toBe(true)
  })

  it('never hands a token on beside a config folder, even one in our own environment', () => {
    const base = { PATH: '/bin', CLAUDE_CODE_OAUTH_TOKEN: TOKEN }
    const full = withAccountEnv(base, { CLAUDE_CONFIG_DIR: '/x' })
    expect(full.CLAUDE_CONFIG_DIR).toBe('/x')
    expect('CLAUDE_CODE_OAUTH_TOKEN' in full).toBe(false)
    expect(full.PATH).toBe('/bin')
    // A token account and the login are left as they were.
    expect(withAccountEnv(base, { CLAUDE_CODE_OAUTH_TOKEN: 'other' }).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      'other'
    )
    expect(withAccountEnv(base, {}).CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN)
  })
})

describe('a full login’s config folder', () => {
  const source = (): string => join(dir, 'dot-claude')

  it('links what is shared and nothing that belongs to an account', () => {
    const src = source()
    for (const d of [
      'skills',
      'agents',
      'commands',
      'plugins',
      'hooks',
      'backups',
      'statsig',
      'cache'
    ])
      mkdirSync(join(src, d), { recursive: true })
    for (const f of [
      'settings.json',
      'settings.local.json',
      'CLAUDE.md',
      'history.jsonl',
      '.credentials.json',
      '.claude.json',
      '.config.json',
      '.claude-staging-oauth.json',
      'policy-limits.json',
      'policy-limits.json.signature.json',
      'remote-settings.json',
      'mcp-needs-auth-cache.json',
      'server.lock'
    ])
      writeFileSync(join(src, f), '{}')
    const acct = join(dir, 'acct')
    linkClaudeConfigDir(acct, src, join(dir, 'none.json'))
    const linked = (n: string): boolean =>
      existsSync(join(acct, n)) && lstatSync(join(acct, n)).isSymbolicLink()
    for (const n of [
      'settings.json',
      'settings.local.json',
      'CLAUDE.md',
      'history.jsonl',
      'skills',
      'agents',
      'commands',
      'plugins',
      'hooks',
      // made in ~/.claude when it is missing, so every transcript lands there
      'projects'
    ])
      expect(linked(n), n).toBe(true)
    expect(existsSync(join(src, 'projects'))).toBe(true)
    for (const n of [
      '.credentials.json',
      '.claude.json',
      '.config.json',
      '.claude-staging-oauth.json',
      'policy-limits.json',
      'policy-limits.json.signature.json',
      'remote-settings.json',
      'mcp-needs-auth-cache.json',
      'server.lock',
      'backups',
      'statsig',
      'cache'
    ])
      expect(existsSync(join(acct, n)), n).toBe(false)
    expect(CLAUDE_NOT_SHARED.has('.credentials.json')).toBe(true)
    // Repeatable, and picks up what ~/.claude gained since; never replaces
    // what the account wrote of its own.
    writeFileSync(join(acct, 'keybindings.json'), 'mine')
    writeFileSync(join(src, 'keybindings.json'), 'theirs')
    mkdirSync(join(src, 'output-styles'))
    linkClaudeConfigDir(acct, src, join(dir, 'none.json'))
    expect(linked('output-styles')).toBe(true)
    expect(readFileSync(join(acct, 'keybindings.json'), 'utf8')).toBe('mine')
  })

  it('copies the user’s MCP servers into its own global config and keeps who it is', () => {
    const acct = join(dir, 'acct')
    mkdirSync(acct)
    writeFileSync(
      join(acct, '.claude.json'),
      JSON.stringify({ oauthAccount: { emailAddress: 'b@x.com' }, userID: 'b' })
    )
    const main = join(dir, 'main.json')
    writeFileSync(
      main,
      JSON.stringify({
        oauthAccount: { emailAddress: 'a@x.com' },
        userID: 'a',
        mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app' } },
        projects: {
          '/p': { mcpServers: { db: { command: 'db' } }, allowedTools: ['x'], lastCost: 3 },
          '/q': { lastCost: 1 }
        }
      })
    )
    syncClaudeGlobalConfig(acct, main)
    const own = JSON.parse(readFileSync(join(acct, '.claude.json'), 'utf8'))
    expect(own.oauthAccount).toEqual({ emailAddress: 'b@x.com' })
    expect(own.userID).toBe('b')
    expect(own.mcpServers).toEqual({ linear: { type: 'http', url: 'https://mcp.linear.app' } })
    expect(own.projects).toEqual({ '/p': { mcpServers: { db: { command: 'db' } } } })
    // A server taken out of ~/.claude.json goes from the account too.
    writeFileSync(main, JSON.stringify({ projects: {} }))
    syncClaudeGlobalConfig(acct, main)
    expect(JSON.parse(readFileSync(join(acct, '.claude.json'), 'utf8')).mcpServers).toBeUndefined()
    // A half-written file of the account's is never overwritten.
    writeFileSync(join(acct, '.claude.json'), '{"oauthAcc')
    syncClaudeGlobalConfig(acct, main)
    expect(readFileSync(join(acct, '.claude.json'), 'utf8')).toBe('{"oauthAcc')
  })
})

describe('a full login’s credentials', () => {
  const cred = (expiresAt: number, accessToken = 'at-1'): string =>
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'rt', expiresAt } })

  it('are in the Keychain item Claude Code names after the folder', () => {
    // sha256("/tmp/cove-claude-acct") starts 85cef479 (shasum -a 256).
    expect(claudeCredentialService('/tmp/cove-claude-acct')).toBe(
      'Claude Code-credentials-85cef479'
    )
    expect(claudeCredentialService('/tmp/other')).not.toBe(
      claudeCredentialService('/tmp/cove-claude-acct')
    )
  })

  it('are read from the Keychain, as text or hex, and only while good', async () => {
    const folder = join(dir, 'acct')
    const service = claudeCredentialService(folder)
    kc.items.set(service, cred(Date.now() + 3_600_000))
    expect(await claudeConfigToken(folder)).toBe('at-1')
    kc.items.set(service, Buffer.from(cred(Date.now() + 3_600_000, 'at-hex')).toString('hex'))
    expect(await claudeConfigToken(folder)).toBe('at-hex')
    // About to expire: not used (and never refreshed from here).
    kc.items.set(service, cred(Date.now() + 30_000))
    expect(await claudeConfigToken(folder)).toBeNull()
    expect(accessTokenFrom('not json')).toBeNull()
  })

  it('fall back to the folder’s .credentials.json', async () => {
    const folder = join(dir, 'acct')
    mkdirSync(folder)
    writeFileSync(join(folder, '.credentials.json'), cred(Date.now() + 3_600_000, 'at-file'))
    expect(await claudeConfigToken(folder)).toBe('at-file')
    // The main login's item is never what an account folder reads.
    kc.items.set('Claude Code-credentials', cred(Date.now() + 3_600_000, 'main'))
    rmSync(join(folder, '.credentials.json'))
    expect(await claudeConfigToken(folder)).toBeNull()
  })
})

describe('signing another Claude account in fully', () => {
  it('names it after who signed in, in a fresh cookie jar of its own', async () => {
    const a = await signedIn()
    const acct = listAccounts('claude').find((x) => x.id === a.id)!
    expect(acct.kind).toBe('config')
    expect(acct.name).toBe('campaigns@songpush.com')
    expect(acct.detail).toBe('campaigns@songpush.com · Max plan')
    expect(a.partition).toMatch(/^persist:claude-/)
    expect(a.partition).not.toBe('persist:agent-signin')
    const second = await signedIn('other@songpush.com')
    expect(second.partition).not.toBe(a.partition)
  })

  it('leaves nothing behind when the sign-in does not finish', async () => {
    let folder = ''
    await expect(
      addClaudeLogin(
        'Work',
        async (env) => {
          folder = env.CLAUDE_CONFIG_DIR
          kc.items.set(claudeCredentialService(folder), '{}')
          return { ok: false, cancelled: true, error: 'Cancelled.' }
        },
        async () => null
      )
    ).rejects.toThrow('Cancelled.')
    expect(existsSync(folder)).toBe(false)
    expect(kc.removed).toEqual([claudeCredentialService(folder)])
    expect(listAccounts('claude').map((a) => a.id)).toEqual([LOGIN_ID.claude])
    // Signed in, but the CLI does not say so: also nothing.
    await expect(
      addClaudeLogin(
        '',
        async () => ({ ok: true }),
        async () => ({ detail: '', signedIn: false })
      )
    ).rejects.toThrow(/did not finish/)
    expect(listAccounts('claude')).toHaveLength(1)
  })

  it('will not add the same person twice', async () => {
    await signedIn()
    await expect(signedIn()).rejects.toThrow('campaigns@songpush.com is already added.')
    expect(listAccounts('claude')).toHaveLength(2)
  })

  it('takes a token account’s place: its chats and its default move to the new one', async () => {
    const token = addClaudeToken('Campaigns', TOKEN)
    pinChatAccount('c1', token.id)
    pinChatAccount('c2', LOGIN_ID.claude)
    setDefaultAccount('claude', token.id)
    const full = await signedIn('campaigns@songpush.com', '', token.id)
    _resetAccountsForTests()
    const all = listAccounts('claude')
    expect(all.map((a) => a.id)).toEqual([LOGIN_ID.claude, full.id])
    // The name the user gave it is kept.
    expect(all[1].name).toBe('Campaigns')
    expect(accountForChat('claude', 'c1').id).toBe(full.id)
    expect(accountForChat('claude', 'c2').id).toBe(LOGIN_ID.claude)
    expect(all[1].isDefault).toBe(true)
    expect(readFileSync(join(dir, 'accounts.json'), 'utf8')).not.toContain(token.id)
  })

  it('removing it takes its folder, its Keychain item and its default with it', async () => {
    const full = await signedIn()
    setDefaultAccount('claude', full.id)
    removeAccount(full.id)
    expect(existsSync(full.env.CLAUDE_CONFIG_DIR)).toBe(false)
    expect(kc.removed).toContain(claudeCredentialService(full.env.CLAUDE_CONFIG_DIR))
    expect(listAccounts('claude')[0].isDefault).toBe(true)
  })
})

describe('the default account for new chats', () => {
  it('is the login until another is chosen', () => {
    const work = addClaudeToken('Work', TOKEN)
    expect(listAccounts('claude').map((a) => a.isDefault)).toEqual([true, false])
    expect(accountForChat('claude', undefined).id).toBe(LOGIN_ID.claude)
    setDefaultAccount('claude', work.id)
    expect(listAccounts('claude').map((a) => a.isDefault)).toEqual([false, true])
    // What the phone's accounts.list reports for a new chat (rpc.ts).
    expect(accountForChat('claude', undefined).id).toBe(work.id)
    expect(accountForChat('claude', 'never-pinned').id).toBe(work.id)
    expect(JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8')).defaults).toEqual({
      claude: work.id
    })
    // Back to the login.
    setDefaultAccount('claude', LOGIN_ID.claude)
    expect(accountForChat('claude', undefined).id).toBe(LOGIN_ID.claude)
  })

  it('a chat’s own pick still wins', () => {
    const work = addClaudeToken('Work', TOKEN)
    setDefaultAccount('claude', work.id)
    pinChatAccount('c1', LOGIN_ID.claude)
    expect(accountForChat('claude', 'c1').id).toBe(LOGIN_ID.claude)
  })

  it('out of allowance, the first with some is used; with all out, the default', () => {
    const work = addClaudeToken('Work', TOKEN)
    const spare = addClaudeToken('Spare', TOKEN.slice(0, -1) + 'b')
    setDefaultAccount('claude', spare.id)
    expect(accountForChat('claude', undefined).id).toBe(spare.id)
    markLimited(spare.id, Date.now() + 60_000)
    expect(accountForChat('claude', undefined).id).toBe(LOGIN_ID.claude)
    markLimited(LOGIN_ID.claude, Date.now() + 60_000)
    expect(accountForChat('claude', undefined).id).toBe(work.id)
    markLimited(work.id, Date.now() + 60_000)
    expect(accountForChat('claude', undefined).id).toBe(spare.id)
    // A pinned chat with everything out stays on its pick.
    pinChatAccount('c1', work.id)
    expect(accountForChat('claude', 'c1').id).toBe(work.id)
  })

  it('goes back to the login when the default is removed, and is kept per agent', () => {
    const work = addClaudeToken('Work', TOKEN)
    setDefaultAccount('claude', work.id)
    expect(() => setDefaultAccount('codex', work.id)).toThrow()
    expect(() => setDefaultAccount('claude', 'claude:nope')).toThrow()
    expect(accountForChat('codex', undefined).id).toBe(LOGIN_ID.codex)
    removeAccount(work.id)
    _resetAccountsForTests()
    expect(JSON.parse(readFileSync(join(dir, 'accounts.json'), 'utf8')).defaults).toEqual({})
    expect(accountForChat('claude', undefined).id).toBe(LOGIN_ID.claude)
    expect(listAccounts('claude')[0].isDefault).toBe(true)
  })
})
