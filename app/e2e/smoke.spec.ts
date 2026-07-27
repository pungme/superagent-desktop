import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * End-to-end smoke suite. Launches the built Electron app against a throwaway
 * userData dir and a seeded test project, so it needs no native dialogs and
 * leaves the user's real config untouched.
 *
 * Prereq: `npm run build` (produces out/main/index.js).
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-proj-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# e2e project\n')

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
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

test('window opens with the SuperAgent title', async () => {
  expect(await window.title()).toBe('SuperAgent')
})

test('onboarding renders, then the main app loads with the seeded workspace', async () => {
  // Onboarding shows first; skip it deterministically.
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })

  // Seeded group + workspace are present.
  await expect(window.locator('.sidebar-group-title')).toContainText('My projects')
  await expect(window.locator('.sidebar-item-name')).toContainText('e2e-project')
})

test('opening the workspace shows the chat composer and toolbar actions', async () => {
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
  await expect(window.locator('textarea.easy-input')).toBeVisible()
  await expect(window.locator('.toolbar-btn:has-text("Routines")')).toBeVisible()
  await expect(window.locator('.toolbar-btn:has-text("Skills")')).toBeVisible()
})

test('the file tree lists project files', async () => {
  await window.click('.toolbar-btn:has-text("Files")')
  await window.waitForSelector('.file-tree', { timeout: 10_000 })
  await expect(window.locator('.file-tree')).toContainText('README.md', { timeout: 10_000 })
  // Toggle it back off so later tests see the default layout.
  await window.click('.toolbar-btn:has-text("Files")')
})

test('the browser preview pane can be toggled on', async () => {
  await window.click('.toolbar-btn:has-text("Show preview")')
  await window.waitForSelector('.browser-pane', { timeout: 10_000 })
  await expect(window.locator('.browser-address')).toBeVisible()
})

test('the Settings panel opens from the sidebar gear', async () => {
  await window.click('.sidebar-settings')
  await window.waitForSelector('.settings-panel', { timeout: 5_000 })
  await expect(window.locator('.settings-panel')).toContainText('Settings')
  await window.click('.skills-close')
})

test('the new-project dialog offers Code and Browser projects', async () => {
  await window.hover('.sidebar-group-header')
  await window.click('.group-add')
  await window.waitForSelector('.new-project', { timeout: 5_000 })
  await expect(window.locator('.new-project')).toContainText('Code project')
  await expect(window.locator('.new-project')).toContainText('Browser project')
  await window.click('.new-project-cancel')
  await expect(window.locator('.new-project')).toHaveCount(0)
})
