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
/** Superagent starts Brave with --remote-debugging-port; read it back off the process. */
function bravePort(): string {
  const line = execSync('ps -Ao command')
    .toString()
    .split('\n')
    .find((l) => l.includes(braveProfile()) && l.includes('--remote-debugging-port='))!
  return /--remote-debugging-port=(\d+)/.exec(line)![1]
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-ext-data-'))
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
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
  expect(left, 'Brave should quit with Superagent').toBe('')
})

test('the project offers the installed browsers and starts on the built-in one', async () => {
  const list = await window.evaluate(() => window.cove.browsersList())
  expect(list.map((b) => b.id)).toEqual(expect.arrayContaining(['builtin', 'brave']))
  expect(await window.evaluate((id) => window.cove.browsersGet(id), wsId)).toBe('builtin')
})

test('picking Brave launches it with its own profile', async () => {
  const res = await window.evaluate((id) => window.cove.browsersSet(id, 'brave'), wsId)
  expect(res.ok).toBe(true)
  expect(await window.evaluate((id) => window.cove.browsersGet(id), wsId)).toBe('brave')
  // Its profile is Superagent's, under the app's data folder — never the user's own.
  expect(existsSync(join(userDataDir, 'browsers', 'brave'))).toBe(true)
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

/** Brave's own view of its tabs, over its remote-control port (in the profile). */
async function braveTabs(): Promise<{ id: string; url: string; type: string }[]> {
  const port = bravePort()
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as {
    id: string
    url: string
    type: string
  }[]
  return list.filter((t) => t.type === 'page')
}

test('closing the agent’s tab: its next step opens a fresh one', async () => {
  const tab = (await braveTabs()).find((t) => t.url.startsWith(siteUrl))!
  await fetch(`http://127.0.0.1:${bravePort()}/json/close/${tab.id}`)
  await expect.poll(async () => (await braveTabs()).some((t) => t.id === tab.id)).toBe(false)
  expect(await tool('browser_navigate', { url: `${siteUrl}?again` })).toContain('again')
  expect(await tool('browser_evaluate', { expression: 'document.title' })).toContain('Shop')
})

test('two chats in one project each get their own tab', async () => {
  const other = await window.evaluate((id) => window.cove.chatCreate(id), wsId)
  await tool('browser_navigate', { url: `${siteUrl}?chat=one` })
  await tool('browser_navigate', { url: `${siteUrl}?chat=two` }, other)
  const urls = (await braveTabs()).map((t) => t.url)
  expect(urls).toEqual(expect.arrayContaining([`${siteUrl}?chat=one`, `${siteUrl}?chat=two`]))
  // Each chat still drives its own.
  expect(await tool('browser_evaluate', { expression: 'location.search' })).toContain('one')
  expect(await tool('browser_evaluate', { expression: 'location.search' }, other)).toContain('two')
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
    [`--user-data-dir=${join(userDataDir, 'browsers', 'brave')}`, '--no-first-run'],
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
