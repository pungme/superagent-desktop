import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'

/**
 * "Sometimes the browser doesn't load at all": a pane whose page has died (crashed, killed
 * or closed by the page itself) left a view whose webContents was undefined. The code
 * meant to bury it threw on every bounds update, 16 ms apart, the pane was never
 * replaced, and every address sent to it was dropped as NO-PANE. It is replaced now,
 * on the page it was on, and an address typed into it loads.
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

const paneLog = (): string => {
  const f = join(userDataDir, 'pane-debug.log')
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}
const pagesAt = (url: string): Promise<number> =>
  app.evaluate(
    ({ webContents }, u) =>
      webContents.getAllWebContents().filter((w) => !w.isDestroyed() && w.getURL().startsWith(u))
        .length,
    url
  )

test('a pane whose page died is replaced, and an address typed into it loads', async () => {
  const id = `${wsId}::${chatId}`
  expect(await pagesAt(siteUrl)).toBe(1)
  // Away from the window (a chat switch hides it), then its page dies.
  await window.evaluate((p) => window.cove.browserHide(p), id)
  await app.evaluate(({ webContents }, u) => {
    for (const w of webContents.getAllWebContents())
      if (!w.isDestroyed() && w.getURL().startsWith(u)) w.close()
  }, siteUrl)
  await expect.poll(() => pagesAt(siteUrl)).toBe(0)
  // The window wants it back on screen and keeps saying so, as it does every 250 ms.
  for (let i = 0; i < 6; i++) {
    await window.evaluate(
      (p) => window.cove.browserSetBounds(p, { x: 300, y: 120, width: 600, height: 500 }),
      id
    )
    await window.waitForTimeout(120)
  }
  // A new pane stands in its place, on the page it was on, and nothing was thrown.
  await expect.poll(() => pagesAt(siteUrl), { timeout: 10_000 }).toBe(1)
  expect(paneLog()).toContain('pane-revived')
  expect(paneLog()).not.toContain('uncaught-exception')

  // Dead again, and now an address is typed: loaded, not dropped.
  await app.evaluate(({ webContents }, u) => {
    for (const w of webContents.getAllWebContents())
      if (!w.isDestroyed() && w.getURL().startsWith(u)) w.close()
  }, siteUrl)
  await expect.poll(() => pagesAt(siteUrl)).toBe(0)
  await window.evaluate((a) => window.cove.browserNavigate(a.id, a.url), {
    id,
    url: `${siteUrl}other`
  })
  await expect.poll(() => pagesAt(`${siteUrl}other`), { timeout: 10_000 }).toBe(1)
  expect(paneLog()).not.toContain('NO-PANE')
})
