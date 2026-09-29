import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'

/**
 * A project that groups several repos (like wepush): its repos fold apart from
 * its conversations. One caret for both put every repo in among the chats.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-repos-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-repos-proj-'))
  for (const r of ['backend', 'frontend', 'ios']) {
    const d = join(projectDir, r)
    mkdirSync(d)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d })
    writeFileSync(join(d, 'README.md'), `# ${r}\n`)
  }
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
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    await window.cove.chatCreate(ws.id)
    await window.cove.chatCreate(ws.id)
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir]) rmSync(d, { recursive: true, force: true })
})

const toggle = (): ReturnType<Page['locator']> => window.locator('.repo-tree-toggle')
const repoRows = (): ReturnType<Page['locator']> =>
  window.locator('.repo-tree-row:not(.repo-tree-toggle)')
const chatRows = (): ReturnType<Page['locator']> =>
  window.locator(
    '.sidebar-item:has-text("e2e-project") ~ .routine-tree .routine-tree-row:not(.repo-tree-row)'
  )

test('the repos sit behind their own row, folded; the conversations show', async () => {
  await expect(toggle()).toContainText('3 repos', { timeout: 15_000 })
  await expect(toggle()).toHaveAttribute('aria-expanded', 'false')
  await expect(repoRows()).toHaveCount(0)
  await expect.poll(() => chatRows().count(), { timeout: 10_000 }).toBeGreaterThan(0)
})

test('opening the repos leaves the conversations as they were', async () => {
  const chats = await chatRows().count()
  await toggle().click()
  await expect(repoRows()).toHaveCount(3)
  expect(await chatRows().count()).toBe(chats)
  await window.waitForTimeout(300) // the caret's turn
  await window.locator('.sidebar').screenshot({ path: 'test-results/repos-fold.png' })
  await toggle().click()
  await expect(repoRows()).toHaveCount(0)
  expect(await chatRows().count()).toBe(chats)
})

test("the project's caret folds everything under it", async () => {
  const caret = window.locator('.sidebar-item:has-text("e2e-project") .sidebar-item-caret').first()
  await caret.click()
  await expect(toggle()).toHaveCount(0)
  await expect(chatRows()).toHaveCount(0)
  await caret.click()
  await expect(toggle()).toBeVisible()
})
