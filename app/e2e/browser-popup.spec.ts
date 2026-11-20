import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'

/**
 * Sign-in in a popup: "Continue with Google" opens a small window that hands the login
 * back to the page with postMessage. The popup has to stay a window with a link to its
 * opener; loaded into the pane instead, the page loses its opener and the login never
 * arrives. A plain target=_blank link still loads in the pane.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let mcpUrl: string
let wsId: string
let chatId: string
let site: Server
let siteUrl: string

const home = `<!doctype html><meta charset="utf-8"><title>Shop</title>
<button id="login" onclick="window.open('/auth', 'login', 'width=420,height=560')">Continue with Google</button>
<button id="blank" onclick="window.open('about:blank', 'fb', 'width=420,height=560').location = '/auth'">Firebase style</button>
<a id="link" href="/other" target="_blank">Other page</a>
<span id="result"></span>
<script>addEventListener('message', (e) => {
  if (e.origin === location.origin) document.getElementById('result').textContent = 'got:' + e.data
})</script>`
const auth = `<!doctype html><title>Sign in</title>signing in…
<script>opener.postMessage('token-123', location.origin); setTimeout(() => close(), 80)</script>`

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
    result?: { isError?: boolean; content: { text?: string }[] }
    error?: { message: string }
  }
  if (msg.error) throw new Error(msg.error.message)
  const out = msg.result!.content.map((c) => c.text ?? '').join('\n')
  if (msg.result!.isError) throw new Error(out)
  return out
}
const js = async (expression: string): Promise<unknown> =>
  JSON.parse((await tool('browser_evaluate', { expression })).split('\n')[0])

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-popup-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-popup-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# e2e\n')
  site = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(
      req.url === '/auth' ? auth : req.url === '/other' ? '<title>Other</title>other page' : home
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
  await window.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
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
  await window.click('.workspace-toolbar:visible .toolbar-btn:has-text("Browser")')
  await expect(window.locator('.browser-address:visible')).toBeVisible({ timeout: 10_000 })
  expect(await tool('browser_navigate', { url: siteUrl })).toContain('Now at')
  await expect.poll(() => js('window.innerWidth > 200')).toBe(true)
})

test.afterAll(async () => {
  await app?.close()
  site?.close()
  for (const d of [userDataDir, projectDir]) rmSync(d, { recursive: true, force: true })
})

const windowCount = (): Promise<number> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)

test('a sign-in popup hands its login back to the page that opened it, and closes', async () => {
  const before = await windowCount()
  await js("(document.getElementById('login').click(), 'clicked')")
  // The opener received the token the popup posted: it never lost its link to it.
  await expect.poll(() => js("document.getElementById('result').textContent")).toBe('got:token-123')
  // The page itself stayed where it was: the popup did not take over the pane.
  expect(await js('location.href')).toBe(siteUrl)
  // And the popup window went away when it closed itself.
  await expect.poll(windowCount).toBe(before)
})

test('about:blank first, navigated after (Firebase, Auth0), works the same', async () => {
  await js("(document.getElementById('result').textContent = '', 'cleared')")
  await js("(document.getElementById('blank').click(), 'clicked')")
  await expect.poll(() => js("document.getElementById('result').textContent")).toBe('got:token-123')
  expect(await js('location.href')).toBe(siteUrl)
})

test('an ordinary link that opens a new tab still loads in the pane', async () => {
  const before = await windowCount()
  await js("(document.getElementById('link').click(), 'clicked')")
  await expect.poll(() => js('document.title')).toBe('Other')
  expect(await windowCount()).toBe(before)
})
