import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

/**
 * A screenshot you just took is offered above the composer, to attach or
 * dismiss. The folder macOS saves to is swapped for a temp one here.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string
let shotsDir: string

// An 8×8 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGNwaDiAFTEMLQkAYvNgAXSglMMAAAAASUVORK5CYII=',
  'base64'
)
const shoot = (name: string): void => writeFileSync(join(shotsDir, name), PNG)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-shots-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-shots-proj-'))
  shotsDir = mkdtempSync(join(tmpdir(), 'cove-shots-dir-'))
  writeFileSync(join(projectDir, 'README.md'), '# shots e2e\n')
  // Already there before the app started: not "just taken".
  shoot('Screenshot 2026-01-01 at 09.00.00.png')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      COVE_E2E_SCREENSHOT_DIR: shotsDir,
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
  })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('textarea.easy-input', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir, shotsDir]) rmSync(d, { recursive: true, force: true })
})

test('an old screenshot is not offered; a new one is', async () => {
  await window.waitForTimeout(1500)
  await expect(window.locator('.easy-shots')).toHaveCount(0)
  shoot('Screenshot 2026-09-29 at 20.10.00.png')
  await expect(window.locator('.easy-shots')).toContainText('Screenshot just taken', {
    timeout: 10_000
  })
  // Not a screenshot by its name: left alone.
  writeFileSync(join(shotsDir, 'holiday.png'), PNG)
  await window.waitForTimeout(1500)
  await expect(window.locator('.easy-shot')).toHaveCount(1)
})

test('several stack into one suggestion, and Attach all attaches them', async () => {
  shoot('Screenshot 2026-09-29 at 20.10.05.png')
  await expect(window.locator('.easy-shots')).toContainText('2 screenshots', { timeout: 10_000 })
  await window.locator('.easy-shots').screenshot({ path: 'test-results/screenshot-suggestion.png' })
  await window.getByRole('button', { name: 'Attach all' }).click()
  await expect(window.locator('.easy-shots')).toHaveCount(0)
  await expect(window.locator('.easy-attachment img')).toHaveCount(2)
})

test('one can be dropped, and × dismisses the rest', async () => {
  shoot('Screenshot 2026-09-29 at 20.11.00.png')
  shoot('Screenshot 2026-09-29 at 20.11.05.png')
  await expect(window.locator('.easy-shot')).toHaveCount(2, { timeout: 10_000 })
  await window.locator('.easy-shot').first().hover()
  await window.locator('.easy-shot-remove').first().click()
  await expect(window.locator('.easy-shot')).toHaveCount(1)
  await window.getByRole('button', { name: 'Dismiss' }).click()
  await expect(window.locator('.easy-shots')).toHaveCount(0)
  // Nothing was attached by that.
  await expect(window.locator('.easy-attachment img')).toHaveCount(2)
})

test('a shot taken in one chat is offered in the chat you switch to', async () => {
  // A second project, and its chat open, as if the wrong one were on screen.
  const other = mkdtempSync(join(tmpdir(), 'cove-shots-other-'))
  writeFileSync(join(other, 'README.md'), '# other\n')
  const otherId = await window.evaluate(async (path) => {
    const tree = await window.cove.storeTree()
    const group = tree.find((g) => g.workspaces.some((w) => w.name === 'e2e-project'))!
    const name = path.split('/').pop()!
    const { workspaceId } = await window.cove.createWorkspace(group.id, name, path)
    await window.cove.chatCreate(workspaceId)
    return workspaceId
  }, other)
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click(`.sidebar-item:has-text("${other.split('/').pop()}")`)
  await window.waitForSelector('textarea.easy-input:visible', { timeout: 20_000 })
  shoot('Screenshot 2026-09-29 at 20.20.00.png')
  await expect(window.locator('.easy-shots:visible')).toContainText('Screenshot just taken', {
    timeout: 10_000
  })
  // Now the right one.
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(window.locator('.easy-shots:visible')).toContainText('Screenshot just taken', {
    timeout: 10_000
  })
  await window.getByRole('button', { name: 'Attach', exact: true }).click()
  // Taken once, attached once: no longer offered in the other chat either.
  await window.click(`.sidebar-item:has-text("${other.split('/').pop()}")`)
  await window.waitForTimeout(500)
  await expect(window.locator('.easy-shots:visible')).toHaveCount(0)
  expect(otherId).toBeTruthy()
  rmSync(other, { recursive: true, force: true })
})
