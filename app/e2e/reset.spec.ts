import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Settings → Reset Superagent: after a confirm, every project, group and chat
 * is gone and the app starts over. The test build reloads the window instead of
 * relaunching (COVE_E2E_NO_RELAUNCH), which Playwright can't follow.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-reset-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-reset-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# keep me\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      COVE_E2E_NO_RELAUNCH: '1',
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
})

test('Reset removes every project, group and chat, after asking', async () => {
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    await window.cove.chatCreate(ws.id)
    await window.cove.createGroup('Clients')
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await expect(window.locator('.sidebar-item', { hasText: 'e2e-project' })).toBeVisible()

  await window.click('.sidebar-settings[title="Settings"]')
  await window.click('.settings-nav-item:has-text("Advanced")')
  const reset = window.getByRole('button', { name: 'Reset…' })

  // Cancel changes nothing.
  window.once('dialog', (d) => void d.dismiss())
  await reset.click()
  expect(await window.evaluate(async () => (await window.cove.chatListAll()).length)).toBe(1)

  window.once('dialog', (d) => {
    expect(d.message()).toContain('can’t be undone')
    void d.accept()
  })
  await reset.click()
  await expect
    .poll(() => window.evaluate(async () => (await window.cove.chatListAll()).length), {
      timeout: 10_000
    })
    .toBe(0)
  const tree = await window.evaluate(() => window.cove.storeTree())
  expect(tree.flatMap((g) => g.workspaces)).toEqual([])
  expect(tree.map((g) => g.name)).not.toContain('Clients')
  // The project's own files are never touched.
  expect(existsSync(join(projectDir, 'README.md'))).toBe(true)
  // Starts over like a new install: onboarding again.
  expect(await window.evaluate(() => localStorage.getItem('cove.onboarded'))).toBeNull()
})
