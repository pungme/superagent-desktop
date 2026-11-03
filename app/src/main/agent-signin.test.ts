import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

/**
 * Signing in inside Superagent, with a stand-in for `claude auth login`: the
 * link it opens is caught and shown in our window, a pasted code is typed into
 * it, and Google turning the window away sends the link to the user's browser.
 * No real CLI, no network beyond a local port the fake listens on.
 */

const h = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('events') as typeof import('events')
  const state = {
    root: '',
    bin: '',
    windows: [] as InstanceType<typeof FakeWindow>[],
    opened: [] as string[]
  }
  class FakeContents extends EventEmitter {
    urls: string[] = []
    setWindowOpenHandler(): void {
      // the window keeps its popups; nothing to record
    }
  }
  class FakeWindow extends EventEmitter {
    webContents = new FakeContents()
    destroyed = false
    constructor(public opts: { webPreferences: { partition: string } }) {
      super()
      state.windows.push(this)
    }
    loadURL(url: string): Promise<void> {
      this.webContents.urls.push(url)
      queueMicrotask(() => this.emit('ready-to-show'))
      return Promise.resolve()
    }
    show(): void {
      // never on screen in a test
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    destroy(): void {
      this.destroyed = true
    }
  }
  return { ...state, state, FakeWindow }
})

vi.mock('electron', () => ({
  app: { getPath: () => h.state.root },
  BrowserWindow: h.FakeWindow,
  shell: { openExternal: async (u: string) => void h.state.opened.push(u) }
}))
vi.mock('./browser', () => ({ applyBrowserIdentity: () => {} }))
vi.mock('./claude-cli', () => ({
  findClaude: () => h.state.bin,
  findCodex: () => 'codex',
  findAgy: () => 'agy',
  agentEnv: () => ({ PATH: process.env.PATH })
}))

import { BROWSER_FALLBACK_NOTE, signInAgent } from './agent-signin'

/**
 * A fake `claude auth login`. It prints the paste-a-code link, then (unless
 * PASTE_ONLY) hands the returning link to $BROWSER as Claude Code does, and
 * finishes on whichever comes first: its port being called, or a code on stdin.
 */
const FAKE = `#!${process.execPath}
const http = require('http'), fs = require('fs'), { execFileSync } = require('child_process')
const log = (k, v) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify([k, v]) + '\\n')
log('env', { dir: process.env.CLAUDE_CONFIG_DIR || null, token: 'CLAUDE_CODE_OAUTH_TOKEN' in process.env })
const srv = http.createServer((req, res) => { res.end('ok'); log('callback', req.url); srv.close(); process.exit(0) })
srv.listen(0, '127.0.0.1', () => {
  const port = srv.address().port
  console.log('Opening browser... If it does not open, visit: https://claude.ai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=xyz')
  if (!process.env.PASTE_ONLY) execFileSync(process.env.BROWSER, ['https://claude.ai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A' + port + '%2Fcallback&state=xyz'])
  log('port', port)
})
process.stdin.on('data', (c) => { const code = c.toString().trim(); log('code', code); process.exit(code === 'abc#xyz' ? 0 : 1) })
`

let logFile = ''
const logged = (): [string, unknown][] =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l))
    : []
const waitFor = async <T>(f: () => T | undefined | null | false, ms = 8000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const v = f()
    if (v) return v
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** Where a returning link sends the browser back to: the CLI's own port. */
const callbackOf = (url: string): string =>
  decodeURIComponent(new URL(url).searchParams.get('redirect_uri')!).replace(
    'localhost',
    '127.0.0.1'
  )

beforeEach(() => {
  h.state.root = mkdtempSync(join(tmpdir(), 'cove-signin-'))
  h.state.bin = join(h.state.root, 'claude')
  writeFileSync(h.state.bin, FAKE)
  chmodSync(h.state.bin, 0o755)
  logFile = join(h.state.root, 'log')
  process.env.FAKE_LOG = logFile
  h.state.windows.length = 0
  h.state.opened.length = 0
})
afterEach(() => {
  delete process.env.PASTE_ONLY
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  rmSync(h.state.root, { recursive: true, force: true })
})

describe('signing Claude in inside Superagent', () => {
  it('shows the link the CLI opens in our window and finishes when it returns', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-should-not-reach-the-cli'
    const done = signInAgent('claude', null, {
      env: { CLAUDE_CONFIG_DIR: join(h.state.root, 'acct') },
      partition: 'persist:claude-test'
    })
    const win = await waitFor(() => h.state.windows[0])
    const url = await waitFor(() => win.webContents.urls[0])
    // The returning link (to the CLI's own port), not the paste-a-code one.
    expect(url).toMatch(
      /^https:\/\/claude\.ai\/oauth\/authorize\?.*redirect_uri=http%3A%2F%2Flocalhost%3A\d+/
    )
    expect(win.opts.webPreferences.partition).toBe('persist:claude-test')
    // The page sends the browser back to the CLI's port, as claude.ai would.
    await fetch(callbackOf(url) + '?code=1&state=xyz')
    expect(await done).toEqual({ ok: true })
    expect(win.destroyed).toBe(true)
    expect(logged().find(([k]) => k === 'env')?.[1]).toEqual({
      dir: join(h.state.root, 'acct'),
      token: false
    })
  })

  it('types the code from the paste-a-code page into the CLI', async () => {
    process.env.PASTE_ONLY = '1'
    const done = signInAgent('claude', null)
    const win = await waitFor(() => h.state.windows[0], 10_000)
    const url = await waitFor(() => win.webContents.urls[0])
    expect(url).toContain('https://claude.ai/oauth/authorize')
    // The main login keeps its own jar.
    expect(win.opts.webPreferences.partition).toBe('persist:agent-signin')
    win.webContents.emit(
      'did-navigate',
      {},
      'https://platform.claude.com/oauth/code/callback?code=abc&state=xyz'
    )
    expect(await done).toEqual({ ok: true })
    expect(logged().find(([k]) => k === 'code')?.[1]).toBe('abc#xyz')
  }, 15_000)

  it('sends the link to the user’s browser when Google turns the window away', async () => {
    const done = signInAgent('claude', null, { partition: 'persist:claude-g' })
    const win = await waitFor(() => h.state.windows[0])
    const url = await waitFor(() => win.webContents.urls[0])
    win.webContents.emit(
      'did-navigate',
      {},
      'https://accounts.google.com/v3/signin/rejected?continue=x'
    )
    expect(h.state.opened).toEqual([url])
    const note = decodeURIComponent(win.webContents.urls[1] ?? '')
    expect(note).toContain(BROWSER_FALLBACK_NOTE)
    // Said once, however often Google says no.
    win.webContents.emit('did-navigate', {}, 'https://accounts.google.com/signin/rejected')
    expect(h.state.opened).toHaveLength(1)
    // The user's browser returns to the CLI's port; the window closes itself.
    await fetch(callbackOf(url) + '?code=1&state=xyz')
    expect(await done).toEqual({ ok: true })
    expect(win.destroyed).toBe(true)
  })

  it('closing the window cancels', async () => {
    const done = signInAgent('claude', null)
    const win = await waitFor(() => h.state.windows[0])
    await waitFor(() => win.webContents.urls[0])
    win.emit('closed')
    expect(await done).toEqual({ ok: false, cancelled: true, error: 'Cancelled.' })
  })
})
