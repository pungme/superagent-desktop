import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

let app: ElectronApplication
let page: Page
let dir: string
test.describe.configure({ mode: 'serial' })
test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'superagent-mail-ui-'))
  app = await electron.launch({
    args: [join(__dirname, '..', 'out/main/index.js')],
    env: { ...process.env, COVE_USER_DATA: dir, NODE_ENV: 'production' }
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // Only UI plumbing is exercised here. Never open Mail or request real permission.
  await app.evaluate(({ ipcMain }) => {
    const ready = { installed: true, loggedIn: true, version: 'test' }
    const absent = { installed: false, loggedIn: false, version: null }
    let connected = false
    let attempt = 0
    ipcMain.removeHandler('env:detect')
    ipcMain.handle('env:detect', () => ({
      claude: ready,
      codex: absent,
      antigravity: absent,
      loggedIn: true,
      claudeInstalled: true,
      claudeVersion: 'test'
    }))
    for (const name of ['mail:status', 'mail:connect', 'mail:disconnect'])
      ipcMain.removeHandler(name)
    ipcMain.handle('mail:status', () => ({ supported: true, connected }))
    ipcMain.handle('mail:connect', () => {
      attempt++
      if (attempt === 1)
        return {
          supported: true,
          connected: false,
          error: 'Mail permission was denied. Enable Mail in Automation settings.'
        }
      connected = true
      return { supported: true, connected }
    })
    ipcMain.handle('mail:disconnect', () => {
      connected = false
      return { supported: true, connected }
    })
  })
  await page.evaluate(() => {
    localStorage.removeItem('cove.onboarded')
    localStorage.removeItem('cove.connectionsOffered')
  })
  await page.reload()
})
test.afterAll(async () => {
  await app?.close()
  rmSync(dir, { recursive: true, force: true })
})

test('checks ready agents then offers optional Mail; handles denial and retry', async () => {
  await expect(page.getByText('Step 1 of 2 · Check your agents')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Connect your apps' })).toBeVisible({
    timeout: 15000
  })
  await expect(page.locator('.mail-connection-heading')).toContainText('Not connected')
  await page.screenshot({ path: '/tmp/superagent-mail-onboarding.png' })
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('permission was denied')
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Continue to Superagent' }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('cove.connectionsOffered'))).toBe('1')
})

test('Settings retains the connection, disconnects it, and survives reload', async () => {
  await page.locator('.sidebar-settings[title="Settings"]').click()
  await page.getByRole('button', { name: 'Connections', exact: false }).click()
  await expect(page.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible()
  await page.screenshot({ path: '/tmp/superagent-mail-settings.png' })
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator('.sidebar')).toBeVisible()
  await expect(page.locator('.connections-offer')).toHaveCount(0)
})

test('existing users get a dismissible offer that opens Connections directly', async () => {
  await page.evaluate(() => localStorage.removeItem('cove.connectionsOffered'))
  await page.reload()
  await expect(page.locator('.connections-offer')).toBeVisible()
  await page.getByRole('button', { name: 'Open Settings → Connections' }).click()
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Connect', exact: true })).toBeVisible()
})

test('Skip for now finishes onboarding without requiring a connection', async () => {
  await page.evaluate(() => localStorage.removeItem('cove.onboarded'))
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Connect your apps' })).toBeVisible({
    timeout: 15000
  })
  await page.getByRole('button', { name: 'Skip for now', exact: true }).click()
  await expect(page.locator('.sidebar')).toBeVisible()
})

test('install errors belong to one agent and clear when rechecking', async () => {
  await app.evaluate(({ ipcMain }) => {
    const absent = { installed: false, loggedIn: false, version: null }
    ipcMain.removeHandler('env:detect')
    ipcMain.handle('env:detect', () => ({
      claude: absent,
      codex: absent,
      antigravity: absent,
      loggedIn: false,
      claudeInstalled: false,
      claudeVersion: null
    }))
    ipcMain.removeHandler('env:install')
    ipcMain.handle('env:install', () => ({ ok: false, error: 'Test installer failed' }))
  })
  await page.evaluate(() => localStorage.removeItem('cove.onboarded'))
  await page.reload()
  const agents = page.locator('.onboarding-agent')
  await agents.first().getByRole('button', { name: 'Install', exact: true }).click()
  await expect(agents.first()).toContainText('Test installer failed')
  await expect(agents.nth(1)).not.toContainText('Test installer failed')
  await expect(agents.nth(2)).not.toContainText('Test installer failed')
  await page.getByRole('button', { name: 'Re-check', exact: true }).click()
  await expect(page.getByText('Test installer failed')).toHaveCount(0)
  await page.getByRole('button', { name: 'Skip setup for now' }).click()
  await expect(page.getByRole('heading', { name: 'Connect your apps' })).toBeVisible()
})
