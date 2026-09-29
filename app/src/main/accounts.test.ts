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
vi.mock('./claude-cli', () => ({ findClaude: () => 'claude', findCodex: () => 'codex' }))

import {
  _resetAccountsForTests,
  accountEnv,
  accountForChat,
  addClaudeToken,
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
  reportLimit,
  setLimitMode
} from './accounts'

let dir: string
const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cove-accounts-'))
  process.env.COVE_USER_DATA = dir
  h.broadcasts.length = 0
  _resetAccountsForTests()
})
afterEach(() => {
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
