import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Save for later: ⌘S sets what is being written aside for this chat, "N saved"
 * brings it back (what is in the box then is set aside in its place), and ⌘K
 * lists it.
 */

let app: ElectronApplication
let window: Page
let data: string
let proj: string

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-e2e-saved-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-e2e-saved-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
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
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
})

test('⌘S sets the prompt aside, and "saved" brings it back, swapping with what is there', async () => {
  const box = window.locator('textarea.easy-input:visible')
  await box.fill('Make the pricing cards yearly by default')
  await box.press('Meta+s')
  await expect(box).toHaveValue('')
  const chip = window.locator('.saved-chip:visible')
  await expect(chip).toHaveText('1 saved')
  // Another prompt, then bring the first back: the second is set aside in its place.
  await box.fill('Fix the footer links')
  await chip.click()
  const menu = window.locator('.saved-menu')
  await expect(menu.locator('.saved-text')).toHaveText(['Make the pricing cards yearly by default'])
  await window.screenshot({ path: 'test-results/saved-prompts-menu.png' })
  await menu.getByRole('button', { name: 'Use' }).click()
  await expect(box).toHaveValue('Make the pricing cards yearly by default')
  await expect(chip).toHaveText('1 saved')
  await chip.click()
  await expect(menu.locator('.saved-text')).toHaveText(['Fix the footer links'])
  // Thrown away: no chip left.
  await menu.getByRole('button', { name: 'Remove' }).click()
  await expect(chip).toHaveCount(0)
})

test('the save button does the same, and ⌘K lists saved prompts and puts one back', async () => {
  const box = window.locator('textarea.easy-input:visible')
  await box.fill('Check the sign-up form on a phone')
  await window.getByRole('button', { name: 'Save for later' }).click()
  await expect(box).toHaveValue('')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('menu:command-palette')
  })
  await window.waitForSelector('.cmdk-panel', { timeout: 5_000 })
  await expect(window.locator('.cmdk-section-label', { hasText: 'Saved for later' })).toBeVisible()
  await window.locator('.cmdk-item', { hasText: 'Check the sign-up form on a phone' }).click()
  await expect(box).toHaveValue('Check the sign-up form on a phone', { timeout: 5_000 })
  await expect(window.locator('.saved-chip:visible')).toHaveCount(0)
})

test('a prompt saved on the phone shows in the composer at once', async () => {
  const chatId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return (await window.cove.chatList(ws.id))[0].id
  })
  const json = JSON.stringify([{ id: 'p1', text: 'Saved on the iPhone', at: Date.now() }])
  await app.evaluate(
    ({ BrowserWindow }, p) =>
      BrowserWindow.getAllWindows()[0]?.webContents.send('saved-prompts:changed', p),
    { chatId, json }
  )
  const chip = window.locator('.saved-chip:visible')
  await expect(chip).toHaveText('1 saved')
  await chip.click()
  await expect(window.locator('.saved-menu .saved-text')).toHaveText(['Saved on the iPhone'])
  await window.locator('.saved-menu').getByRole('button', { name: 'Remove' }).click()
  await expect(chip).toHaveCount(0)
})
