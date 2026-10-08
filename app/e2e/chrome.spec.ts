import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { homedir, tmpdir } from 'os'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'
import { execSync } from 'child_process'

/**
 * The agent's tools in the user's real Google Chrome — the other browser a
 * project can be pointed at, and one the Brave spec says nothing about.
 *
 * Runs where there is a Chrome: installed, or in the folder named by
 * COVE_E2E_BROWSER_DIR (a mounted download does). Skipped otherwise.
 *
 *   COVE_E2E_BROWSER_DIR=/path/with/Google\ Chrome.app npx playwright test e2e/chrome.spec.ts
 */
const DIRS = [
  ...(process.env.COVE_E2E_BROWSER_DIR ? [process.env.COVE_E2E_BROWSER_DIR] : []),
  '/Applications',
  join(homedir(), 'Applications')
]
const HAS_CHROME = DIRS.some((d) => existsSync(join(d, 'Google Chrome.app')))
test.skip(!HAS_CHROME, 'Google Chrome is not installed (or set COVE_E2E_BROWSER_DIR)')

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let mcpUrl: string
let wsId: string
let chatId: string
let site: Server
let siteUrl: string

const html = `<!doctype html><meta name="viewport" content="width=device-width"><title>Shop</title>
<label for=n>Your name</label><input id=n name=who value=Ada>
<label for=c>Colour</label><select id=c name=colour><option>Red</option><option>Blue</option></select>
<button onclick="document.title = 'hello ' + document.getElementById('n').value">Go</button>
<button onclick="document.title = 'c:' + confirm('Sure?')">Ask</button>
<button onclick="document.title = 'p:' + prompt('Name?', 'x')">Name it</button>
<input type=file id=f style=display:none onchange="document.title = 'f:' + this.files[0].name">
<div style=height:3000px></div><button onclick="document.title = 'end'">The end</button>`

async function tool(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await fetch(
    `${mcpUrl}?ws=${encodeURIComponent(wsId)}&chat=${encodeURIComponent(chatId)}`,
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
  return msg.result!.content.map((c) => c.text ?? c.data ?? '').join('\n')
}
const title = (): Promise<string> => tool('browser_evaluate', { expression: 'document.title' })
const profile = (): string => join(userDataDir, 'browsers', 'chrome')
const chromeRunning = (): string =>
  execSync(`pgrep -f ${JSON.stringify('[-]-user-data-dir=' + profile())} || true`)
    .toString()
    .trim()

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-chrome-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-chrome-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# e2e\n')
  site = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
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
  const made = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return { wsId: ws.id, chatId: await window.cove.chatCreate(ws.id) }
  })
  wsId = made.wsId
  chatId = made.chatId
  await window.click('.sidebar-item:has-text("e2e-project")')
})

test.afterAll(async () => {
  await app?.close()
  site?.close()
  // Whatever of Chrome is left on that profile goes with the test.
  try {
    execSync(`pkill -f ${JSON.stringify('[-]-user-data-dir=' + profile())} || true`)
  } catch {
    // none left
  }
  // Chrome is still writing its profile for a moment after it is told to go.
  for (let i = 0; i < 50 && chromeRunning(); i++) execSync('sleep 0.1')
  for (const d of [userDataDir, projectDir])
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

test('Chrome is offered, and picking it starts it on a profile of its own', async () => {
  const list = await window.evaluate(() => window.cove.browsersList())
  expect(list.map((b: { id: string }) => b.id)).toContain('chrome')
  const res = await window.evaluate(
    (id) => window.cove.browsersSet(id, 'chrome'),
    `${wsId}::${chatId}`
  )
  expect(res, JSON.stringify(res)).toMatchObject({ ok: true })
  expect(await tool('browser_navigate', { url: siteUrl })).toContain('(in Chrome)')
  expect(await title()).toContain('Shop')
  expect(existsSync(profile())).toBe(true)
  expect(chromeRunning()).not.toBe('')
  // The page does not see a browser being driven.
  expect(await tool('browser_evaluate', { expression: 'navigator.webdriver' })).toContain('false')
})

test('the pane shows Chrome live', async () => {
  const browserBtn = window.locator('.workspace-toolbar:visible .toolbar-btn:has-text("Browser")')
  if ((await browserBtn.getAttribute('title')) !== 'Hide the browser') await browserBtn.click()
  await expect(window.locator('.external-pane-view img')).toBeVisible({ timeout: 15_000 })
})

test('read, click, type and screenshot', async () => {
  const page = await tool('browser_read_page')
  expect(page).toContain('"label":"Your name"')
  expect(page).toContain('"options":["Red","Blue"]')
  await tool('browser_click', { text: 'Your name' })
  await tool('browser_type', { text: ' L' })
  await tool('browser_click', { text: 'Go' })
  expect(await title()).toContain('hello Ada L')
  expect((await tool('browser_screenshot')).length).toBeGreaterThan(1000)
})

test('a select, dialogs, scrolling, a file and reload', async () => {
  expect(await tool('browser_select_option', { text: 'Colour', option: 'Blue' })).toContain('Blue')
  expect(await tool('browser_click', { text: 'Ask' })).toContain('"Sure?" — answered Cancel')
  expect(await title()).toContain('c:false')
  await tool('browser_dialog', { accept: true })
  expect(await tool('browser_click', { text: 'Ask' })).toContain('answered OK')
  expect(await title()).toContain('c:true')
  await tool('browser_dialog', { accept: true, text: 'Zed' })
  expect(await tool('browser_click', { text: 'Name it' })).toContain('answered "Zed"')
  expect(await title()).toContain('p:Zed')
  expect(await tool('browser_scroll', { direction: 'bottom' })).toContain('(the bottom)')
  await tool('browser_click', { text: 'The end' })
  expect(await title()).toContain('end')
  const file = join(userDataDir, 'for-chrome.txt')
  writeFileSync(file, 'x')
  expect(await tool('browser_upload_file', { paths: [file] })).toContain('for-chrome.txt')
  await expect.poll(title).toContain('f:for-chrome.txt')
  expect(await tool('browser_reload')).toContain('Now at')
  expect(await title()).toContain('Shop')
})

test('phone size, tabs, and starting again after Chrome is quit', async () => {
  expect(await tool('browser_set_viewport', { viewport: 'mobile' })).toContain('mobile')
  expect(
    Number(await tool('browser_evaluate', { expression: 'document.documentElement.clientWidth' }))
  ).toBeLessThan(500)
  await tool('browser_set_viewport', { viewport: 'desktop' })
  expect(await tool('browser_open_tab', { url: `${siteUrl}?tab=new` })).toContain('yours now')
  expect(await tool('browser_tabs')).toContain('tab=new')
  execSync(`pkill -f ${JSON.stringify('[-]-user-data-dir=' + profile())} || true`)
  await expect.poll(chromeRunning, { timeout: 10_000 }).toBe('')
  expect(await tool('browser_navigate', { url: `${siteUrl}?back` })).toContain('back')
  expect(await title()).toContain('Shop')
})
