import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'

/**
 * The agent asks before it moves a conversation to the user's own browser.
 * browser_use('yours') is called over the tool server as Claude Code calls it;
 * a card shows in the chat, and nothing launches until the user taps.
 *
 * No real browser: Brave, Chrome and Edge are stand-ins (COVE_E2E_BROWSER_DIR)
 * whose "binary" only writes down that it was started, so a launch cannot go
 * unnoticed and the test runs where none is installed.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let fakeApps: string
let launched: string
let mcpUrl: string
let wsId: string
let chatId: string

async function tool(name: string, args: Record<string, unknown>, chat = chatId): Promise<string> {
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
    result?: { content: { text?: string }[] }
    error?: { message: string }
  }
  if (msg.error) throw new Error(msg.error.message)
  return msg.result!.content.map((c) => c.text ?? '').join('\n')
}

const browserOf = (chat = chatId): Promise<string> =>
  window.evaluate((scope) => window.cove.browsersGet(scope), `${wsId}::${chat}`)
const launches = (): string => (existsSync(launched) ? readFileSync(launched, 'utf8') : '')

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-bask-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-bask-proj-'))
  fakeApps = mkdtempSync(join(tmpdir(), 'cove-e2e-bask-apps-'))
  launched = join(fakeApps, 'launched.txt')
  writeFileSync(join(projectDir, 'README.md'), '# e2e\n')
  // Whichever one counts as "yours" on this Mac, it is a stand-in.
  for (const [bundle, binary] of [
    ['Brave Browser.app', 'Brave Browser'],
    ['Google Chrome.app', 'Google Chrome'],
    ['Microsoft Edge.app', 'Microsoft Edge']
  ]) {
    const dir = join(fakeApps, bundle, 'Contents', 'MacOS')
    mkdirSync(dir, { recursive: true })
    const bin = join(dir, binary)
    writeFileSync(bin, `#!/bin/sh\necho "${binary}" >> '${launched}'\n`)
    chmodSync(bin, 0o755)
  }

  const urlFile = join(userDataDir, 'mcp-url.txt')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      COVE_E2E_MCP_URL_FILE: urlFile,
      COVE_E2E_BROWSER_DIR: fakeApps,
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
  const tree = await window.evaluate(() => window.cove.storeTree())
  wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
  await window.click('.sidebar-item:has-text("e2e-project")')
  // A conversation on screen, made the way a person would: ⌘K → New chat.
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
  for (const dir of [userDataDir, projectDir, fakeApps])
    if (dir) rmSync(dir, { recursive: true, force: true })
})

test('the agent asks first, and nothing launches before "Use"', async () => {
  const pending = tool('browser_use', { which: 'yours', why: 'this shop needs your own login' })
  const card = window.locator('.easy-browser-ask:visible')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card.locator('.easy-browser-ask-what')).toHaveText(
    /^Claude wants to use your (Brave|Chrome|Edge): this shop needs your own login\.$/
  )
  const name = (await card.locator('.easy-guard-trust').textContent())!.replace(/^Use /, '')
  await expect(card.getByRole('button')).toHaveText(['Stay here', `Use ${name}`])

  // The card waits; the conversation has not moved and no browser started.
  await window.waitForTimeout(1500)
  expect(launches()).toBe('')
  expect(await browserOf()).toBe('builtin')

  if (process.env.COVE_E2E_SHOTS) {
    mkdirSync(process.env.COVE_E2E_SHOTS, { recursive: true })
    await card.screenshot({ path: join(process.env.COVE_E2E_SHOTS, 'card.png') })
    await window.screenshot({ path: join(process.env.COVE_E2E_SHOTS, 'window.png') })
  }

  await card.getByRole('button', { name: `Use ${name}` }).click()
  const said = await pending
  expect(said).toContain(`now drive ${name}`)
  await expect(card).toHaveCount(0)
  expect(await browserOf()).not.toBe('builtin')
  // Still nothing launched: it opens on the agent's next navigate, as before.
  expect(launches()).toBe('')

  // Already on their browser: no card the next time.
  expect(await tool('browser_use', { which: 'yours' })).toContain(`now drive ${name}`)
  await expect(window.locator('.easy-browser-ask')).toHaveCount(0)
  await tool('browser_use', { which: 'built-in' })
  expect(await browserOf()).toBe('builtin')
})

test('"Stay here" keeps the built-in browser, and is not asked again for a while', async () => {
  const pending = tool('browser_use', { which: 'yours' })
  const card = window.locator('.easy-browser-ask:visible')
  // No reason given: a plain default.
  await expect(card.locator('.easy-browser-ask-what')).toHaveText(
    /^Claude wants to use your (Brave|Chrome|Edge): this site needs your own logins\.$/,
    { timeout: 10_000 }
  )
  await card.getByRole('button', { name: 'Stay here' }).click()
  const said = await pending
  expect(said).toContain("stay in Superagent's built-in browser")
  expect(said).toContain('browser_ask_user')
  expect(said).toContain('next 30 minutes')
  expect(await browserOf()).toBe('builtin')

  // Asked again at once: no card, the same answer, nothing launched.
  const again = await tool('browser_use', { which: 'yours' })
  expect(again).toMatch(/^Not asked again/)
  await expect(window.locator('.easy-browser-ask')).toHaveCount(0)
  expect(await browserOf()).toBe('builtin')
  expect(launches()).toBe('')
})

test('picking a browser in the Browser pill needs no card', async () => {
  const other = await window.evaluate((id) => window.cove.chatCreate(id), wsId)
  const list = await window.evaluate(() => window.cove.browsersList())
  const pick = list.find((b) => b.id !== 'builtin')!
  // The pill's own call (it launches the browser, here a stand-in).
  await window.evaluate(
    ([scope, id]) => window.cove.browsersSet(scope, id as 'brave'),
    [`${wsId}::${other}`, pick.id]
  )
  expect(await browserOf(other)).toBe(pick.id)
  expect(await tool('browser_use', { which: 'yours' }, other)).toContain(`now drive ${pick.name}`)
  await expect(window.locator('.easy-browser-ask')).toHaveCount(0)
})
