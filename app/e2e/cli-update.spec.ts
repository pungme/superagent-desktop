import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/** Settings → Agents says Claude Code is kept up to date, and the switch is remembered. */

let app: ElectronApplication
let window: Page
let data: string
let proj: string

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-e2e-cliupd-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-e2e-cliupd-proj-'))
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
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
})

test('Claude Code is kept up to date unless switched off', async () => {
  await window.click('.sidebar-settings[title="Settings"]')
  await window.click('.settings-nav-item:has-text("Agents")')
  const row = window.locator('.settings-row', { hasText: 'Keep it up to date' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('New models show up in the picker')
  // On by default; the switch is stored for the Mac side to read.
  expect(await window.evaluate(() => localStorage.getItem('cove.cliAutoUpdate'))).toBeNull()
  await row.locator('label.switch').click()
  await expect
    .poll(() => window.evaluate(() => localStorage.getItem('cove.cliAutoUpdate')))
    .toBe('0')
  await window.screenshot({ path: 'test-results/cli-update-row.png' })
})
