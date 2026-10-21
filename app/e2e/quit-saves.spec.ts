import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Quitting waits for conversations to save — and for nothing else. A crashed
 * web view is skipped, a hung one is named and the user may quit anyway, and a
 * reply still streaming when ⌘Q lands is on disk when the app comes back.
 */
function launch(
  data: string,
  proj: string,
  extra: Record<string, string> = {}
): Promise<ElectronApplication> {
  return electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      NODE_ENV: 'production',
      ...extra
    }
  })
}
async function ready(app: ElectronApplication): Promise<void> {
  const page = await app.firstWindow()
  await page.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await page.reload()
  await page.waitForSelector('.sidebar', { timeout: 20_000 })
}
/** A second window on the app page: its preload joins the flush, like the dot's. */
async function secondWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(async ({ BrowserWindow }) => {
    const first = BrowserWindow.getAllWindows()[0]
    const w = new BrowserWindow({
      show: false,
      webPreferences: first.webContents.getLastWebPreferences()
    })
    await w.loadURL(first.webContents.getURL())
    ;(globalThis as { extra?: unknown }).extra = w
  })
}
const quitTime = async (app: ElectronApplication): Promise<number> => {
  const t0 = Date.now()
  const closed = app.waitForEvent('close', { timeout: 60_000 })
  await app.evaluate(({ app }) => app.quit()).catch(() => {})
  await closed
  return Date.now() - t0
}
let data: string
let proj: string
test.beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'cove-quit-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-quit-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
})
test.afterEach(() => {
  for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
})

test('a crashed web view does not hold up quitting', async () => {
  const app = await launch(data, proj)
  await ready(app)
  await secondWindow(app)
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => !x.isVisible())!
    w.webContents.forcefullyCrashRenderer()
  })
  await new Promise((r) => setTimeout(r, 1000))
  expect(await quitTime(app)).toBeLessThan(8000)
})

test('a hung web view is named, and the app can still quit', async () => {
  test.setTimeout(90_000)
  const app = await launch(data, proj, { COVE_E2E_QUIT_ANYWAY: '1' })
  await ready(app)
  // Hang the app window itself a moment from now: it is the window whose
  // conversations the guard waits for.
  await app.evaluate(({ BrowserWindow }) => {
    void BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
      'setTimeout(() => { for (;;) {} }, 50); 0'
    )
  })
  await new Promise((r) => setTimeout(r, 1000))
  const took = await quitTime(app)
  expect(took).toBeGreaterThan(14_000)
  expect(took).toBeLessThan(40_000)
  const log = readFileSync(join(data, 'memory.log'), 'utf8')
  expect(log).toMatch(/quit: did not finish saving: .*did not answer in 15s/)
})

test('a reply still streaming at ⌘Q is on disk when the app comes back', async () => {
  test.setTimeout(90_000)
  let app = await launch(data, proj)
  await ready(app)
  const page = await app.firstWindow()
  const id = await page.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return window.cove.chatCreate(ws.id)
  })
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('agent:start')
    ipcMain.handle('agent:start', () => 'quit-agent')
    ipcMain.removeHandler('agent:suggestTitle')
    ipcMain.handle('agent:suggestTitle', () => null)
    ipcMain.removeAllListeners('agent:send')
    ipcMain.on('agent:send', () => {})
  })
  await page.click('.sidebar-item:has-text("e2e-project")')
  const input = page.locator('textarea.easy-input:visible')
  await input.fill('save me on quit')
  await input.press('Enter')
  await page.waitForTimeout(500)
  const send = (e: unknown): Promise<void> =>
    app.evaluate(
      ({ BrowserWindow }, event) =>
        BrowserWindow.getAllWindows()[0].webContents.send('agent:event:quit-agent', event),
      e
    )
  await send({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: 'text' } }
  })
  for (let i = 0; i < 20; i++) {
    await send({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `tok${i} ` } }
    })
    await page.waitForTimeout(40)
  }
  // No pause: the last tokens have not been autosaved yet when quit arrives.
  await quitTime(app)
  app = await launch(data, proj)
  await app.firstWindow()
  await new Promise((r) => setTimeout(r, 1500))
  const json = await (
    await app.firstWindow()
  ).evaluate((chatId) => window.cove.chatLoad(chatId), id)
  expect(json).toContain('save me on quit')
  expect(json).toContain('tok19')
  await app.close()
})
