import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { createServer, Server } from 'http'
import type { AddressInfo } from 'net'

/**
 * Browser first: the page fills the desk and the chat floats over it, in a view
 * of its own above the page (main/float-chat.ts, float/FloatChat.tsx).
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let site: Server
let siteUrl: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-bf-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-bf-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# e2e project\n')
  site = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(
      '<title>Shop</title><body style="margin:0;background:#f4efe6"><h1>Plants that arrive happy</h1></body>'
    )
  })
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', () => r()))
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
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
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    await window.cove.chatCreate(ws.id)
  })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('textarea.easy-input', { timeout: 20_000 })
  // A page on the desk.
  await window.locator('.workspace-toolbar:visible .toolbar-btn:has-text("Browser")').click()
  const address = window.locator('.browser-address:visible')
  await expect(address).toBeVisible({ timeout: 10_000 })
  await address.fill(siteUrl)
  await address.press('Enter')
})

test.afterAll(async () => {
  await app?.close()
  site?.close()
  for (const d of [userDataDir, projectDir]) rmSync(d, { recursive: true, force: true })
})

/** The floating chat's own page (a view of the window, a page to Playwright). */
async function floatPage(): Promise<Page> {
  let found: Page | undefined
  await expect
    .poll(
      () => {
        found = app.windows().find((p) => p.url().endsWith('#float'))
        return !!found
      },
      { timeout: 15_000 }
    )
    .toBe(true)
  await found!.waitForLoadState('domcontentloaded')
  return found!
}

/** The float view as main has it: shown, where, and whether it is above every page. */
async function floatView(): Promise<{
  visible: boolean
  bounds: Electron.Rectangle
  onTop: boolean
} | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const kids = win.contentView.children as Electron.WebContentsView[]
    const i = kids.findIndex((v) =>
      (v as Electron.WebContentsView).webContents?.getURL().endsWith('#float')
    )
    if (i < 0) return null
    const v = kids[i]
    return { visible: v.getVisible(), bounds: v.getBounds(), onTop: i === kids.length - 1 }
  })
}

test('Browser first: the page takes the whole desk, the chat floats in its corner above the page', async () => {
  const before = await window.locator('.split-side.desk').boundingBox()
  await window
    .locator('.desk-mode-switch:visible')
    .getByRole('button', { name: 'Browser first' })
    .click()
  await expect(window.locator('.split-side-chat.floating')).toHaveCount(1)
  await expect
    .poll(async () => (await window.locator('.split-side.desk').boundingBox())!.width)
    .toBeGreaterThan(before!.width + 100)
  const fl = await floatPage()
  await expect(fl.locator('.fl-mark')).toBeVisible()
  await expect(fl.locator('.fl-hint')).toHaveText('⌘ \\')
  await expect.poll(async () => (await floatView())?.visible).toBe(true)
  const v = (await floatView())!
  expect(v.onTop).toBe(true)
  // Small while it is only the mark, in the bottom-right of the page.
  expect(v.bounds.width).toBeLessThan(120)
  const desk = (await window.locator('.split-side.desk').boundingBox())!
  expect(v.bounds.x + v.bounds.width).toBeGreaterThan(desk.x + desk.width - 40)
  expect(v.bounds.y + v.bounds.height).toBeGreaterThan(desk.y + desk.height - 40)
})

test('clicking the mark opens the box, which stays open; what is typed goes to this chat', async () => {
  const fl = await floatPage()
  // Caught in main, before the app's page: the test checks where it goes, it does not run an agent.
  await app.evaluate(({ ipcMain, BrowserWindow }) => {
    const g = globalThis as { floatSends?: unknown[] }
    g.floatSends = []
    ipcMain.removeAllListeners('float:action')
    ipcMain.on('float:action', (_e, a: { type: string }) => {
      if (a.type === 'send') g.floatSends!.push(a)
      else BrowserWindow.getAllWindows()[0]?.webContents.send('float:action', a)
    })
  })
  await fl.locator('.fl-mark').click()
  await expect(fl.locator('.fl-panel')).not.toHaveClass(/shut/)
  await expect.poll(async () => (await floatView())!.bounds.width).toBeGreaterThan(400)
  const input = fl.getByPlaceholder('Ask Superagent…').first()
  await input.fill('Make the button blue')
  await input.press('Enter')
  await expect
    .poll(() => app.evaluate(() => (globalThis as { floatSends?: unknown[] }).floatSends))
    .toEqual([expect.objectContaining({ text: 'Make the button blue' })])
  const chatId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return (await window.cove.chatList(ws.id))[0].id
  })
  expect(
    await app.evaluate(
      () => ((globalThis as { floatSends?: { chatId: string }[] }).floatSends ?? [])[0]?.chatId
    )
  ).toBe(chatId)
  // Still open after sending, with the esc hint shown.
  await expect(fl.locator('.fl-panel')).not.toHaveClass(/shut/)
  await expect(fl.locator('.fl-esc')).toHaveText('esc')
  await fl.screenshot({ path: 'test-results/browser-first-open.png' })
  // Esc puts it away, and the view shrinks back to the mark after the animation.
  await input.press('Escape')
  await expect(fl.locator('.fl-panel')).toHaveClass(/shut/)
  await expect
    .poll(async () => (await floatView())!.bounds.width, { timeout: 3000 })
    // Back to the mark (wider while it works, for the line saying what it does).
    .toBeLessThan(470)
})

test('the whole chat, then back to side by side', async () => {
  const fl = await floatPage()
  await fl.locator('.fl-mark').click()
  await fl.getByTitle('Show the whole chat (⌘⇧\\)').click()
  await expect(fl.locator('.fl-drawer')).not.toHaveClass(/gone/)
  await fl.getByRole('button', { name: 'Put beside the page' }).click()
  await expect(window.locator('.split-side-chat.floating')).toHaveCount(0)
  await expect.poll(async () => (await floatView())?.visible).toBe(false)
  await expect(
    window.locator('.desk-mode-switch:visible').getByRole('button', { name: 'Side by side' })
  ).toHaveClass(/active/)
  await window.screenshot({ path: 'test-results/browser-first-side.png' })
})

test('a menu over the desk takes the floating chat down while it is open', async () => {
  await window
    .locator('.desk-mode-switch:visible')
    .getByRole('button', { name: 'Browser first' })
    .click()
  await expect.poll(async () => (await floatView())?.visible).toBe(true)
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command-palette')
  })
  await window.waitForSelector('.cmdk-panel', { timeout: 5_000 })
  await expect.poll(async () => (await floatView())?.visible).toBe(false)
  await window.locator('.cmdk-input').press('Escape')
  await expect.poll(async () => (await floatView())?.visible).toBe(true)
})

test('SHOT: the three layers put together, to look at', async () => {
  test.skip(!process.env.SHOT, 'set SHOT=1 to save pictures')
  const fl = await floatPage()
  const shoot = async (name: string): Promise<void> => {
    await window.waitForTimeout(900)
    const parts = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]
      const out: { png: string; x: number; y: number; w: number; h: number }[] = []
      const main = await win.webContents.capturePage()
      const sz = win.getContentSize()
      out.push({ png: main.toPNG().toString('base64'), x: 0, y: 0, w: sz[0], h: sz[1] })
      for (const v of win.contentView.children as Electron.WebContentsView[]) {
        if (!v.webContents || !v.getVisible()) continue
        const b = v.getBounds()
        if (b.width < 2 || b.x < -1000) continue
        const img = await v.webContents.capturePage()
        out.push({ png: img.toPNG().toString('base64'), x: b.x, y: b.y, w: b.width, h: b.height })
      }
      return out
    })
    writeFileSync(join('test-results', `bf-${name}.json`), JSON.stringify(parts))
  }
  await window
    .locator('.desk-mode-switch:visible')
    .getByRole('button', { name: 'Browser first' })
    .click()
  await shoot('mark')
  await fl.locator('.fl-mark').hover()
  await shoot('hover')
  await fl.locator('.fl-mark').click()
  await shoot('open')
  await fl.getByTitle('Show the whole chat (⌘⇧\\)').click()
  await shoot('full')
})
