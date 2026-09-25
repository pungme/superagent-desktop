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

test('window opens with the Superagent title', async () => {
  expect(await window.title()).toBe('Superagent')
})

test('onboarding renders, then the main app loads with the seeded workspace', async () => {
  // Onboarding shows first; skip it deterministically.
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })

  // A fresh install starts flat: the project is there with no group over it.
  // Only the Browse section has a header; no project group was invented.
  // One section for tabs and ungrouped projects (Browse was merged into it).
  await expect(window.locator('.sidebar-group-title')).toHaveText(['Projects'])
  await expect(window.locator('.sidebar-flat .sidebar-item-name')).toContainText('e2e-project')
})

test('opening the workspace shows the chat composer and toolbar actions', async () => {
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
  await expect(window.locator('textarea.easy-input')).toBeVisible()
})

test('the file tree lists project files', async () => {
  await window.click('.toolbar-btn:has-text("Files")')
  await window.waitForSelector('.file-tree', { timeout: 10_000 })
  await expect(window.locator('.file-tree')).toContainText('README.md', { timeout: 10_000 })
  // Toggle it back off so later tests see the default layout.
  await window.click('.toolbar-btn:has-text("Files")')
})

test('a browser tab opens from the sidebar', async () => {
  // The globe on the Projects header (the old "Open a tab to browse" line is gone).
  await window.click('.sidebar-head-actions button[title="New tab"]')
  await window.waitForSelector('.browser-pane', { timeout: 10_000 })
  await expect(window.locator('.browser-address').first()).toBeVisible()
})

test('only a browser tab row has a hover ×; a project is removed from its right-click menu', async () => {
  const project = window.locator('.sidebar-item', { hasText: 'e2e-project' })
  await project.hover()
  await expect(project.locator('.sidebar-item-remove')).toHaveCount(0)
  const tab = window.locator('.sidebar-item.has-remove').first()
  await tab.hover()
  await expect(tab.locator('.sidebar-item-remove')).toHaveCount(1)
})

test("the agent's browser_set_viewport switches the pane to mobile", async () => {
  // What mcp.ts broadcasts for browser_set_viewport('mobile'), aimed at this pane.
  const paneId = await window.locator('[data-pane-id]').first().getAttribute('data-pane-id')
  expect(paneId).toBeTruthy()
  await app.evaluate(({ BrowserWindow }, id) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('browser:viewport-command', {
      paneId: id,
      viewport: 'mobile'
    })
  }, paneId)
  await expect(window.locator('.browser-vp-btn.on').first()).toHaveAttribute('title', /Mobile/)
  // A command for another pane leaves this one alone.
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('browser:viewport-command', {
      paneId: 'some-other-pane',
      viewport: 'desktop'
    })
  })
  await window.waitForTimeout(300)
  await expect(window.locator('.browser-vp-btn.on').first()).toHaveAttribute('title', /Mobile/)
})

test('Settings opens from the sidebar gear and closes with Done', async () => {
  await window.click('.sidebar-settings[title="Settings"]')
  const heading = window.locator('main h1', { hasText: 'Settings' })
  await expect(heading).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('main')).toContainText('Phone')
  await window.click('main button:has-text("Done")')
  await expect(heading).toHaveCount(0)
})

test('a project can be added without making a group first', async () => {
  // Clicking it would open the native folder picker, which e2e can't drive —
  // the affordance being there, at the top level, is the contract.
  // The folder button on the Projects header (the bottom line shows only with no projects).
  await expect(window.locator('.sidebar-head-actions button[title="Add a project"]')).toBeVisible()
})

test('@ mentions reach other projects and folders outside this one', async () => {
  // A second project in the sidebar, with something worth mentioning inside.
  const other = mkdtempSync(join(tmpdir(), 'cove-e2e-other-'))
  mkdirSync(join(other, 'public', 'logo'), { recursive: true })
  writeFileSync(join(other, 'public', 'logo', 'mark.svg'), '<svg/>')
  await window.evaluate(async (path) => {
    const tree = await window.cove.createGroup('Elsewhere')
    const grp = tree.find((g) => g.name === 'Elsewhere')!
    await window.cove.createWorkspace(grp.id, 'levantto', path)
  }, other)
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  // Workspaces visited earlier keep their composer mounted but hidden — take
  // the one on screen.
  const input = window.locator('textarea.easy-input:visible')
  await expect(input).toBeVisible({ timeout: 10_000 })
  await input.click()
  await input.pressSequentially('see @lev')
  // The other project ranks first, labelled as a project.
  const first = window.locator('.easy-mention-item').first()
  await expect(first).toContainText('levantto/')
  await expect(first).toContainText('project')
  await input.press('Enter')
  // Picking a folder inserts its absolute path and keeps the menu open on its contents.
  await expect(input).toHaveValue(`see @${other}/`)
  await expect(window.locator('.easy-mention-item', { hasText: 'public/' })).toBeVisible()
  await input.press('Enter')
  await expect(input).toHaveValue(`see @${other}/public/`)
  await input.pressSequentially('logo/m')
  await input.press('Enter')
  // A file ends the mention with a space, ready for the next word — shown as
  // its pill (the full path goes back in when the message is sent).
  await expect(input).toHaveValue('see @mark.svg ')
  await expect(window.locator('.easy-input-pill')).toHaveText('@mark.svg')
  rmSync(other, { recursive: true, force: true })
})

test('Chats is a plain chat app — no desktop around it', async () => {
  await window.click('.sidebar-dash-row:has-text("Chats")')
  await expect(window.locator('.chats-host .dchat')).toBeVisible({ timeout: 10_000 })
  // The Computer's desktop is not what is on screen.
  await expect(window.locator('.computer-host:visible')).toHaveCount(0)
  await expect(window.locator('.chats-host .dchat-new')).toBeVisible()
})
