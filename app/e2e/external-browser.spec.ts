import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'
import { execSync, spawn } from 'child_process'

/**
 * A project whose agent browses in the user's real Brave: pick it, then drive it
 * with the agent's own tools (called over the tool server, as an agent would),
 * and check the pane streams that tab live. Needs Brave installed, so it skips
 * where it isn't (CI).
 */

const BRAVE = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
test.skip(!existsSync(BRAVE), 'Brave is not installed')

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let mcpUrl: string
let wsId: string
let chatId: string
let site: Server
let siteUrl: string
let everyday: string

/** Call one of the agent's tools, the way Claude Code does over HTTP. */
async function tool(name: string, args: Record<string, unknown>, chat = chatId): Promise<string> {
  // With the chat, as a real session's tool calls are: the pane is per chat.
  const res = await fetch(
    `${mcpUrl}?ws=${encodeURIComponent(wsId)}&chat=${encodeURIComponent(chat)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args }
      })
    }
  )
  const text = await res.text()
  const json = text.startsWith('{')
    ? text
    : text
        .split('\n')
        .find((l) => l.startsWith('data: '))!
        .slice(6)
  const msg = JSON.parse(json) as {
    result?: { content: { text?: string; data?: string }[] }
    error?: { message: string }
  }
  if (msg.error) throw new Error(msg.error.message)
  // Text, or an image's base64 (browser_screenshot).
  return msg.result!.content.map((c) => c.text ?? c.data ?? '').join('\n')
}

const braveProfile = (): string => join(userDataDir, 'browsers', 'brave')
/** Any process still using that profile. The [-] keeps pgrep from matching its own shell. */
const braveRunning = (): string =>
  execSync(`pgrep -f ${JSON.stringify('[-]-user-data-dir=' + braveProfile())} || true`)
    .toString()
    .trim()
/**
 * A stand-in for the user's everyday Brave profile, signed in to a shop and a
 * bank: Chromium's cookie schema (v24), values stored unencrypted, which
 * Chromium also reads. The real encrypted path is sign-ins.test.ts.
 */
function everydayFixture(dir: string): void {
  const expires = (Date.now() + 86_400_000) * 1000 + 11_644_473_600_000_000
  const row = (host: string, name: string, value: string): string =>
    `INSERT INTO cookies VALUES (13400000000000000,'${host}','','${name}','${value}',X'','/',${expires},0,0,13400000000000000,1,1,1,0,1,80,13400000000000000,0,0);`
  execSync(`sqlite3 '${join(dir, 'Cookies')}'`, {
    input: [
      'CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);',
      "INSERT INTO meta VALUES ('version','24'),('last_compatible_version','24');",
      'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL);',
      'CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port);',
      row('admin.shopfixture.test', 'sid', 'shop'),
      row('.bankfixture.test', 'b', 'bank')
    ].join('\n')
  })
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-ext-data-'))
  everyday = mkdtempSync(join(tmpdir(), 'cove-e2e-everyday-'))
  everydayFixture(everyday)
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-ext-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# e2e\n')
  site = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(
      '<meta name="viewport" content="width=device-width"><title>Shop</title>' +
        '<h1 style="width:1100px">A heading too wide for a phone</h1>'
    )
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`

  const urlFile = join(userDataDir, 'mcp-url.txt')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      COVE_E2E_MCP_URL_FILE: urlFile,
      COVE_E2E_EVERYDAY_PROFILE: everyday,
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await expect.poll(() => existsSync(urlFile)).toBe(true)
  mcpUrl = readFileSync(urlFile, 'utf8')
  const tree = await window.evaluate(() => window.cove.storeTree())
  wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
  await window.click('.sidebar-item:has-text("e2e-project")')
  // A conversation to act for, made the way a person would (the seeded project
  // starts without one): ⌘K → New chat, which also makes it the active chat.
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command-palette')
  )
  await window.waitForSelector('.cmdk-panel')
  await window.keyboard.type('New chat')
  await window.keyboard.press('Enter')
  await expect
    .poll(async () => (await window.evaluate((id) => window.cove.chatList(id), wsId)).length)
    .toBeGreaterThan(0)
  chatId = (await window.evaluate((id) => window.cove.chatList(id), wsId))[0].id
})

test.afterAll(async () => {
  await app?.close()
  site?.close()
  // Quitting Superagent quits the Brave it started (closeExternalBrowsers).
  await new Promise((r) => setTimeout(r, 2000))
  const left = braveRunning()
  for (const dir of [userDataDir, projectDir, everyday])
    rmSync(dir, { recursive: true, force: true })
  expect(left, 'Brave should quit with Superagent').toBe('')
})

test('the project offers the installed browsers and starts on the built-in one', async () => {
  const list = await window.evaluate(() => window.cove.browsersList())
  expect(list.map((b) => b.id)).toEqual(expect.arrayContaining(['builtin', 'brave']))
  expect(await window.evaluate((id) => window.cove.browsersGet(id), wsId)).toBe('builtin')
})

test("the agent moves to the user's browser by itself, and back", async () => {
  // The user never names a browser: the agent picks theirs (the Mac's default if
  // it can drive it, else the first installed of Brave, Chrome, Edge).
  expect(await tool('browser_use', { which: 'yours' })).toContain('Brave')
  expect(await window.evaluate((id) => window.cove.browsersGet(id), wsId)).toBe('brave')
  // Navigate says where it landed, since the user can switch mid-conversation.
  expect(await tool('browser_navigate', { url: siteUrl })).toContain('(in Brave)')
  await expect(window.locator('.external-pane-badge')).toHaveText('Brave', { timeout: 10_000 })
  expect(await tool('browser_use', { which: 'built-in' })).toContain('built-in')
  expect(await window.evaluate((id) => window.cove.browsersGet(id), wsId)).toBe('builtin')
})

test('picking Brave launches it with its own profile', async () => {
  const res = await window.evaluate((id) => window.cove.browsersSet(id, 'brave'), wsId)
  expect(res.ok).toBe(true)
  expect(await window.evaluate((id) => window.cove.browsersGet(id), wsId)).toBe('brave')
  // Its profile is Superagent's, under the app's data folder — never the user's own.
  expect(existsSync(join(userDataDir, 'browsers', 'brave'))).toBe(true)
})

test('bringing sign-ins over copies only the sites you tick', async () => {
  const pill = window.locator('.easy-control-btn:has(.easy-control-key:text-is("Browser"))').first()
  await expect(pill.locator('.easy-control-val')).toHaveText('Brave')
  await pill.click()
  await window.locator('.easy-control-item:has-text("Bring sign-ins over")').click()
  const dialog = window.getByRole('dialog', { name: 'Bring sign-ins over' })
  await expect(dialog.locator('.signins-row')).toHaveText(['bankfixture.test', 'shopfixture.test'])
  await dialog.getByText('shopfixture.test').click()
  await dialog.getByRole('button', { name: 'Bring over 1 site' }).click()
  await expect(dialog).toContainText('now signed in to shopfixture.test', { timeout: 20_000 })
  await dialog.getByRole('button', { name: 'Done' }).click()
  // The agent's profile has the shop's sign-in and not the bank's.
  const hosts = execSync(
    `sqlite3 '${join(userDataDir, 'browsers', 'brave', 'Default', 'Cookies')}' 'SELECT host_key FROM cookies'`
  )
    .toString()
    .trim()
    .split('\n')
  expect(hosts).toContain('admin.shopfixture.test')
  expect(hosts).not.toContain('.bankfixture.test')
})

test("the agent's navigate drives Brave, and the pane streams it live", async () => {
  const out = await tool('browser_navigate', { url: siteUrl })
  expect(out).toContain('127.0.0.1')
  await expect(window.locator('.external-pane')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('.external-pane-badge')).toHaveText('Brave')
  await expect(window.locator('.external-pane-view img')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('.external-pane-url')).toContainText('127.0.0.1')
  expect(await tool('browser_evaluate', { expression: 'document.title' })).toContain('Shop')
})

test('the agent checks the page at phone size in Brave', async () => {
  expect(await tool('browser_set_viewport', { viewport: 'mobile' })).toContain('mobile')
  expect(
    await tool('browser_evaluate', { expression: 'document.documentElement.clientWidth' })
  ).toBe('390')
  const wide = Number(
    await tool('browser_evaluate', { expression: 'document.documentElement.scrollWidth' })
  )
  expect(wide).toBeGreaterThan(390)
  await tool('browser_set_viewport', { viewport: 'desktop' })
})

test('click, type, read and screenshot work in Brave', async () => {
  await tool('browser_evaluate', {
    expression: `(() => { document.body.innerHTML = '<input id="q"><button onclick="document.title=document.getElementById(\\'q\\').value">Go</button>'; return 1 })()`
  })
  // As an agent does: read the page (which numbers what can be clicked), then act.
  const page = await tool('browser_read_page', {})
  expect(page).toContain('Go')
  await tool('browser_click', { index: 0 })
  await tool('browser_type', { text: 'hello' })
  await tool('browser_click', { text: 'Go' })
  expect(await tool('browser_evaluate', { expression: 'document.title' })).toContain('hello')
  const shot = await tool('browser_screenshot', {})
  expect(Buffer.from(shot, 'base64').subarray(1, 4).toString()).toBe('PNG')
})

test('asking the user for help waits for Done', async () => {
  // Listen first, then ask — the ask reaches the window like a permission prompt.
  await window.evaluate(() => {
    ;(window as unknown as { __ask: Promise<unknown> }).__ask = new Promise((resolve) => {
      const off = window.cove.onGuardrailAsk((a) => {
        off()
        resolve(a)
      })
    })
  })
  const pending = tool('browser_ask_user', {
    what: 'Solve the check on the page, then press Done.'
  })
  const ask = (await window.evaluate(
    () => (window as unknown as { __ask: Promise<unknown> }).__ask
  )) as { requestId: string; kind: string; preview: string }
  expect(ask.kind).toBe('handoff')
  expect(ask.preview).toContain('Solve the check')
  await window.evaluate((id) => window.cove.guardrailResolve(id, true, false), ask.requestId)
  expect(await pending).toContain('done')
})

// --- When things go wrong around the agent -----------------------------------

test('two chats in one project each get their own tab', async () => {
  const other = await window.evaluate((id) => window.cove.chatCreate(id), wsId)
  await tool('browser_navigate', { url: `${siteUrl}?chat=one` })
  await tool('browser_navigate', { url: `${siteUrl}?chat=two` }, other)
  // A mark left in one tab isn't in the other: they're separate tabs.
  await tool('browser_evaluate', { expression: '(window.name = "chat-one")' })
  expect(await tool('browser_evaluate', { expression: 'location.search' })).toContain('one')
  expect(await tool('browser_evaluate', { expression: 'location.search' }, other)).toContain('two')
  expect(await tool('browser_evaluate', { expression: 'window.name' }, other)).not.toContain(
    'chat-one'
  )
})

test('quitting Brave mid-task: the next step starts it again', async () => {
  execSync(`pkill -TERM -f ${JSON.stringify(join(userDataDir, 'browsers', 'brave'))} || true`)
  await expect.poll(braveRunning, { timeout: 15_000 }).toBe('')
  expect(await tool('browser_navigate', { url: `${siteUrl}?back` })).toContain('back')
  expect(await tool('browser_evaluate', { expression: 'document.title' })).toContain('Shop')
})

test('Brave already open with its profile, outside Superagent: a clear message, no hang', async () => {
  // Quit ours, then open the same profile the way a person might — without
  // remote control. Superagent can't take it over, and must say so.
  execSync(`pkill -TERM -f ${JSON.stringify(join(userDataDir, 'browsers', 'brave'))} || true`)
  await expect.poll(braveRunning, { timeout: 15_000 }).toBe('')
  const manual = spawn(
    BRAVE,
    [
      `--user-data-dir=${join(userDataDir, 'browsers', 'brave')}`,
      '--no-first-run',
      ...(process.env.COVE_E2E_QUIET === '1' ? ['--headless=new'] : [])
    ],
    {
      stdio: 'ignore',
      detached: true
    }
  )
  try {
    await new Promise((r) => setTimeout(r, 2500))
    const started = Date.now()
    const out = await tool('browser_navigate', { url: siteUrl }).catch((e: Error) => e.message)
    expect(Date.now() - started).toBeLessThan(25_000)
    expect(out).toMatch(/quit it and try again/i)
  } finally {
    manual.kill('SIGTERM')
    execSync(`pkill -TERM -f ${JSON.stringify(join(userDataDir, 'browsers', 'brave'))} || true`)
    await new Promise((r) => setTimeout(r, 1500))
  }
})

test('switching back to the built-in browser restores the normal pane', async () => {
  await window.evaluate((id) => window.cove.browsersSet(id, 'builtin'), wsId)
  await tool('browser_navigate', { url: siteUrl })
  await expect(window.locator('.external-pane')).toHaveCount(0)
  await expect(window.locator('.browser-address').first()).toBeVisible({ timeout: 10_000 })
})

test('"Sign in yourself…" opens it without the agent and says how to finish', async () => {
  await window.evaluate((id) => window.cove.browsersSet(id, 'brave'), wsId)
  await tool('browser_navigate', { url: siteUrl })
  const pill = window.locator('.easy-control-btn:has(.easy-control-key:text-is("Browser"))').first()
  await pill.click()
  await window.locator('.easy-control-item:has-text("Sign in yourself")').click()
  await expect(window.locator('.external-pane-signin')).toContainText('quit it with ⌘Q', {
    timeout: 10_000
  })
  // The agent waits rather than taking the profile back mid-sign-in.
  expect(await tool('browser_navigate', { url: siteUrl })).toMatch(/signing in/)
  // Quitting Superagent closes that window too (checked in afterAll).
})
