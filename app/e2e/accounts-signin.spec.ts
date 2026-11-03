import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'

/**
 * Signing another Claude account in fully, inside Superagent, and its claude.ai
 * connectors. `claude` here is a stand-in (COVE_E2E_CLAUDE_BIN): its `auth
 * login` serves a sign-in page of its own on 127.0.0.1 and hands its link to
 * $BROWSER as Claude Code does, and finishes when the page's Allow returns to
 * it. claude.ai is never reached and nothing is spent.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let fakeDir: string
/** HOME for the app under test: never the user's own ~/.claude or ~/.claude.json. */
let homeDir: string
const TOKEN = 'sk-ant-oat01-' + 'e2e'.repeat(14)
const SHOTS = join(__dirname, '..', '..', '..', '.superagent', 'accounts')

/** The stand-in CLI, in node (the runner's own). */
const FAKE = `#!${process.execPath}
const fs = require('fs'), path = require('path'), http = require('http'), { execFileSync } = require('child_process')
const [cmd, sub] = process.argv.slice(2)
if (cmd === '--version') { console.log('2.1.314 (Claude Code)'); process.exit(0) }
const dir = process.env.CLAUDE_CONFIG_DIR
const cfg = dir ? path.join(dir, '.claude.json') : null
const read = () => { try { return JSON.parse(fs.readFileSync(cfg, 'utf8')) } catch { return {} } }
if (cmd === 'auth' && sub === 'status') {
  if (!dir) console.log(JSON.stringify({ loggedIn: true, email: 'pung@songpush.com', subscriptionType: 'max' }))
  else { const a = read().oauthAccount; console.log(JSON.stringify(a ? { loggedIn: true, email: a.emailAddress, subscriptionType: 'max' } : { loggedIn: false })) }
  process.exit(0)
}
if (cmd === 'auth' && sub === 'login') {
  const srv = http.createServer((req, res) => {
    if (req.url.startsWith('/authorize')) {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>Sign in to Claude</title><body style="font:15px system-ui;padding:40px"><h1>Sign in</h1><p>campaigns@songpush.com</p><a id="allow" href="/callback?code=1&state=s">Allow</a></body>')
      return
    }
    if (req.url.startsWith('/callback')) {
      fs.writeFileSync(cfg, JSON.stringify({ ...read(), oauthAccount: { emailAddress: 'campaigns@songpush.com', organizationUuid: 'org-e2e' } }))
      res.end('Signed in. You can close this window.')
      srv.close(); setTimeout(() => process.exit(0), 50)
    }
  })
  srv.listen(0, '127.0.0.1', () => {
    execFileSync(process.env.BROWSER, ['http://127.0.0.1:' + srv.address().port + '/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fcallback'])
  })
  return
}
if (cmd === 'mcp' && sub === 'list') {
  console.log('Checking MCP server health…\\n')
  console.log('claude.ai Gmail: https://gmailmcp.googleapis.com/mcp/v1 - \\u2714 Connected')
  console.log('claude.ai Attio: https://mcp.attio.com/mcp - ! Needs authentication')
  console.log('claude.ai Superhuman Mail: https://mcp.mail.superhuman.com/mcp - ! Needs authentication')
  process.exit(0)
}
process.exit(0)
`

test.describe.configure({ mode: 'serial' })

const accountsFile = (): {
  accounts: { id: string; name: string; kind: string; partition?: string; configDir?: string }[]
  chats: Record<string, string>
  defaults: Record<string, string>
} => JSON.parse(readFileSync(join(userDataDir, 'accounts.json'), 'utf8'))

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-signin-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-signin-proj-'))
  fakeDir = mkdtempSync(join(tmpdir(), 'cove-signin-cli-'))
  homeDir = mkdtempSync(join(tmpdir(), 'cove-signin-home-'))
  // The app asks a login shell where `claude` is: this one finds the stand-in.
  writeFileSync(join(homeDir, '.zshrc'), `export PATH="${fakeDir}:$PATH"\n`)
  writeFileSync(join(homeDir, '.bashrc'), `export PATH="${fakeDir}:$PATH"\n`)
  mkdirSync(join(homeDir, '.claude', 'skills'), { recursive: true })
  writeFileSync(join(homeDir, '.claude', 'settings.json'), '{}')
  writeFileSync(
    join(homeDir, '.claude.json'),
    JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } } })
  )
  writeFileSync(join(projectDir, 'README.md'), '# sign-in e2e project\n')
  writeFileSync(join(fakeDir, 'claude'), FAKE)
  chmodSync(join(fakeDir, 'claude'), 0o755)
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      COVE_E2E_CLAUDE_BIN: join(fakeDir, 'claude'),
      HOME: homeDir,
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir, fakeDir, homeDir])
    rmSync(d, { recursive: true, force: true })
})

async function openAccounts(): Promise<void> {
  await window.click('.sidebar-settings[title="Settings"]')
  await window.click('.settings-nav-item:has-text("Agents")')
  await expect(window.locator('.settings-accounts')).toBeVisible()
}

/**
 * The sign-in window the next click opens: its page and its address bar (two
 * views in one window, each a page to Playwright).
 */
async function signInWindow(click: () => Promise<void>): Promise<{ page: Page; bar: Page }> {
  const before = new Set(app.windows())
  await click()
  let page: Page | undefined
  let bar: Page | undefined
  await expect
    .poll(
      () => {
        const fresh = app.windows().filter((p) => !before.has(p))
        page = fresh.find((p) => /^http:\/\/127\.0\.0\.1:\d+\//.test(p.url()))
        bar = fresh.find((p) => p.url().startsWith('data:'))
        return !!page && !!bar
      },
      { timeout: 20_000 }
    )
    .toBe(true)
  await page!.waitForLoadState('domcontentloaded')
  return { page: page!, bar: bar! }
}

/** The sign-in window the next click opens, and its Allow pressed. */
async function allowInWindow(click: () => Promise<void>, shot?: string): Promise<void> {
  const { page } = await signInWindow(click)
  expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/authorize/)
  await expect(page.locator('h1')).toHaveText('Sign in')
  if (shot) await page.screenshot({ path: join(SHOTS, shot) })
  await page.click('#allow')
}

test('the main login lists its connectors, and which need connecting', async () => {
  await openAccounts()
  const login = window
    .locator('.settings-accounts-provider', { hasText: 'Claude' })
    .locator('.settings-account')
    .first()
  // Connected ones as chips; the two that are not, folded into one line.
  await expect(login.locator('.settings-connector')).toHaveCount(1, { timeout: 20_000 })
  await expect(login.locator('.settings-connector.connected')).toHaveText('Gmail')
  await login.getByRole('button', { name: '+2 not connected' }).click()
  await expect(login.locator('.settings-connector')).toHaveCount(3)
  await expect(
    login.locator('.settings-connector', { hasText: 'Attio' }).getByRole('button', {
      name: 'Connect'
    })
  ).toBeVisible()
  await login.getByRole('button', { name: 'Hide' }).click()
  await expect(login.locator('.settings-connector')).toHaveCount(1)
})

test('closing the sign-in window adds nothing and leaves nothing behind', async () => {
  const claude = window.locator('.settings-accounts-provider', { hasText: 'Claude' })
  await claude.getByRole('button', { name: 'Add account…' }).click()
  await expect(claude.locator('.settings-accounts-add')).toContainText(
    'Sign in with the other Claude account in the window that opens.'
  )
  await claude
    .locator('.settings-accounts-add')
    .screenshot({ path: join(SHOTS, 'add-account.png') })
  const { page, bar } = await signInWindow(() =>
    claude.getByRole('button', { name: 'Sign in…' }).click()
  )
  // The address is shown, and can be changed: the page goes where it is typed.
  const address = bar.getByRole('textbox', { name: 'Address' })
  await expect(address).toHaveValue(/^http:\/\/127\.0\.0\.1:\d+\/authorize/)
  // (The stand-in only answers /authorize, so the typed address is another one there.)
  const elsewhere = page.url().replace(/\/authorize.*$/, '/authorize?typed=1')
  await address.fill(elsewhere)
  await address.press('Enter')
  await expect.poll(() => page.url()).toBe(elsewhere)
  await expect(address).toHaveValue(elsewhere)
  await bar.screenshot({ path: join(SHOTS, 'sign-in-bar.png') })
  // Back, then its close button: the window goes, and the sign-in with it.
  await bar.getByRole('button', { name: 'Back' }).click()
  await expect.poll(() => page.url()).toMatch(/\/authorize\?redirect_uri=/)
  await bar.getByRole('button', { name: 'Close' }).click()
  await expect.poll(() => page.isClosed()).toBe(true)
  await expect(claude.getByRole('button', { name: 'Sign in…' })).toBeEnabled({ timeout: 10_000 })
  await expect(claude.locator('.settings-accounts-error')).toHaveCount(0)
  await claude.getByRole('button', { name: 'Cancel' }).click()
  await expect(claude.locator('.settings-account')).toHaveCount(1)
  const root = join(userDataDir, 'claude-accounts')
  expect(existsSync(root) ? readdirSync(root) : []).toEqual([])
})

test('Esc closes the sign-in window', async () => {
  const claude = window.locator('.settings-accounts-provider', { hasText: 'Claude' })
  await claude.getByRole('button', { name: 'Add account…' }).click()
  const { page } = await signInWindow(() =>
    claude.getByRole('button', { name: 'Sign in…' }).click()
  )
  // Esc from the page, delivered as the window's own input (not through the page's DOM).
  const url = page.url()
  await app.evaluate(({ webContents }, u) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === u)!
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
  }, url)
  await expect.poll(() => page.isClosed()).toBe(true)
  await expect(claude.getByRole('button', { name: 'Sign in…' })).toBeEnabled({ timeout: 10_000 })
  await claude.getByRole('button', { name: 'Cancel' }).click()
  await expect(claude.locator('.settings-account')).toHaveCount(1)
})

test('a token account signed in fully takes its place, chats and default included', async () => {
  const claude = window.locator('.settings-accounts-provider', { hasText: 'Claude' })
  await claude.getByRole('button', { name: 'Add account…' }).click()
  await claude.getByRole('button', { name: 'Use a token instead' }).click()
  await claude.locator('.settings-accounts-input').first().fill('Campaigns')
  await claude.locator('.settings-accounts-input').nth(1).fill(TOKEN)
  await claude.getByRole('button', { name: 'Add', exact: true }).click()
  const row = claude.locator('.settings-account', { hasText: 'Campaigns' })
  await expect(row.locator('.settings-account-note')).toBeVisible()
  await row.getByRole('button', { name: 'Make default' }).click()
  await expect(row.locator('.settings-account-default')).toBeVisible()
  await window.locator('.settings-accounts').screenshot({ path: join(SHOTS, 'token-note.png') })
  const tokenId = accountsFile().accounts[0].id
  // A chat on the token account.
  const chatId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return await window.cove.chatCreate(ws.id)
  })
  await window.evaluate(([c, id]) => window.cove.accountsPick(c, id), [chatId, tokenId])

  await allowInWindow(
    () => row.getByRole('button', { name: 'Sign in fully' }).click(),
    'sign-in-window.png'
  )
  const full = claude.locator('.settings-account', { hasText: 'Campaigns' })
  await expect(full.locator('.settings-account-detail')).toHaveText(
    'campaigns@songpush.com · Max plan',
    { timeout: 20_000 }
  )
  await expect(full.locator('.settings-account-note')).toHaveCount(0)
  const f = accountsFile()
  expect(f.accounts).toHaveLength(1)
  const acct = f.accounts[0]
  expect(acct).toMatchObject({ kind: 'config', name: 'Campaigns' })
  expect(acct.partition).toMatch(/^persist:claude-/)
  expect(f.chats[chatId]).toBe(acct.id)
  expect(f.defaults.claude).toBe(acct.id)
  expect(JSON.stringify(f)).not.toContain(tokenId)
  // Its config folder: its own .claude.json, shared things linked.
  const own = JSON.parse(readFileSync(join(acct.configDir!, '.claude.json'), 'utf8'))
  expect(own.oauthAccount.emailAddress).toBe('campaigns@songpush.com')
  expect(own.mcpServers).toEqual({ linear: { type: 'http', url: 'https://mcp.linear.app/mcp' } })
  expect(lstatSync(join(acct.configDir!, 'settings.json')).isSymbolicLink()).toBe(true)
  expect(lstatSync(join(acct.configDir!, 'projects')).isSymbolicLink()).toBe(true)
  // Its connectors, read as that account.
  await expect(full.locator('.settings-connector')).toHaveCount(1, { timeout: 20_000 })
  await expect(full.getByRole('button', { name: '+2 not connected' })).toBeVisible()
  await window
    .locator('.settings-accounts')
    .screenshot({ path: join(SHOTS, 'settings-agents.png') })
})

test('the sidebar names the default in one word', async () => {
  await window.click('main button:has-text("Done")')
  await window.locator('.usage-footer-btn').hover()
  await expect(
    window.locator('.usage-popover-row', { hasText: 'Campaigns' }).locator('.usage-popover-default')
  ).toHaveText('Default')
  await window.locator('.usage-popover').screenshot({ path: join(SHOTS, 'usage-popover.png') })
  await window.mouse.move(700, 300)
})

test('a turn that needed a connector puts a Connect card in the chat', async () => {
  const chatId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return (await window.cove.chatList(ws.id))[0].id
  })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('textarea.easy-input', { timeout: 20_000 })
  const accountId = accountsFile().accounts[0].id
  await app.evaluate(
    ({ BrowserWindow }, n) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('connectors:needs-auth', n)
    },
    { chatId, accountId, names: ['Superhuman Mail'] }
  )
  const card = window.locator('.easy-connect')
  await expect(card).toContainText('Superhuman Mail is not connected')
  await expect(card.getByRole('button', { name: 'Connect Superhuman Mail' })).toBeVisible()
  await card.screenshot({ path: join(SHOTS, 'connect-card.png') })
  // Not reachable in a test (claude.ai is never asked): it says so in place.
  await card.getByRole('button', { name: 'Connect Superhuman Mail' }).click()
  await expect(card).toContainText('Could not reach claude.ai for this account')
  await card.getByRole('button', { name: 'Not now' }).click()
  await expect(card).toHaveCount(0)
})
