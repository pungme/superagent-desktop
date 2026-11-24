import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * The agent's logo at the front of the message box is there at every width.
 * It used to show only when the chat was narrow (where the settings fold into
 * it), so closing a pane made "the Claude icon" disappear.
 */

let app: ElectronApplication
let window: Page
let data: string
let proj: string

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-logo-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-logo-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(async () => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
    const tree = await window.cove.storeTree()
    await window.cove.chatCreate(tree.flatMap((g) => g.workspaces)[0].id)
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item >> nth=0')
  await window.waitForSelector('textarea.easy-input', { timeout: 10_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
})

for (const width of [1600, 900]) {
  test(`the logo is in the message box at ${width} px`, async () => {
    await app.evaluate(({ BrowserWindow }, w) => {
      BrowserWindow.getAllWindows()[0].setSize(w, 900)
    }, width)
    await window.waitForTimeout(400)
    const logo = window.locator('.easy-input-agent')
    await expect(logo).toBeVisible()
    // The text starts after it, never under it.
    const box = (await logo.boundingBox())!
    const pad = await window
      .locator('textarea.easy-input')
      .evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
    expect(pad).toBeGreaterThanOrEqual(box.width)
    if (process.env.SHOT)
      await window
        .locator('.easy-input-box')
        .screenshot({ path: `${process.env.SHOT}/composer-logo-${width}.png` })
  })
}
