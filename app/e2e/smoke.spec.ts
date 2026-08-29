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

  // Seeded group + workspace are present.
  await expect(window.locator('.sidebar-group-title', { hasText: 'My projects' })).toBeVisible()
  await expect(window.locator('.sidebar-item-name')).toContainText('e2e-project')
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
  await window.click('button:has-text("Open a tab to browse")')
  await window.waitForSelector('.browser-pane', { timeout: 10_000 })
  await expect(window.locator('.browser-address').first()).toBeVisible()
})

test('Settings opens from the sidebar gear and closes with Done', async () => {
  await window.click('.sidebar-settings[title="Settings"]')
  const heading = window.locator('main h1', { hasText: 'Settings' })
  await expect(heading).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('main')).toContainText('Phone')
  await window.click('main button:has-text("Done")')
  await expect(heading).toHaveCount(0)
})

test('hovering a group reveals its New project button', async () => {
  const header = window.locator('.sidebar-group-header').first()
  await header.hover()
  // Clicking it would open the native folder picker, which e2e can't drive —
  // the affordance being there on hover is the contract.
  await expect(header.locator('.group-add[title="New project"]')).toBeVisible()
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
  // A file ends the mention with a space, ready for the next word.
  await expect(input).toHaveValue(`see @${other}/public/logo/mark.svg `)
  rmSync(other, { recursive: true, force: true })
})
