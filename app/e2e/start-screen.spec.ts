import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * A new person with no project sees what to do: a Start a chat button in the
 * middle, a way to open a folder, and starters. Clicking Start a chat opens a
 * conversation with its composer.
 */

let app: ElectronApplication | undefined
let window: Page
let data: string

/** A fresh app with nobody set up and no project: what a new person sees. */
async function launch(): Promise<void> {
  data = mkdtempSync(join(tmpdir(), 'cove-e2e-start-'))
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, NODE_ENV: 'production' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
}

test.beforeEach(launch)
test.afterEach(async () => {
  await app?.close()
  rmSync(data, { recursive: true, force: true })
})

test('with no project the middle says what to do, and Start a chat starts one', async () => {
  const screen = window.getByTestId('start-screen')
  await expect(screen).toBeVisible()
  await expect(screen).toContainText('What do you want to get done?')
  await expect(window.getByTestId('start-project')).toBeVisible()
  await expect(screen.locator('.start-card')).toHaveCount(4)
  if (process.env.SHOT) {
    // The launch animation plays once, over everything; the picture is of the screen under it.
    await window.evaluate(() => document.querySelector('.intro')?.remove())
    await window.waitForTimeout(300)
    await window.screenshot({ path: join(process.env.SHOT, 'start-screen.png') })
  }

  await window.getByTestId('start-chat').click()
  await expect(window.getByTestId('start-screen')).toHaveCount(0, { timeout: 10_000 })
  await expect(window.locator('textarea, [contenteditable="true"]').first()).toBeVisible({
    timeout: 10_000
  })
})

test('a starter opens a chat and sends its prompt', async () => {
  await window
    .getByTestId('start-screen')
    .locator('.start-card', { hasText: 'Plan my week' })
    .click()
  await expect(window.getByText('Help me plan my week.').first()).toBeVisible({ timeout: 15_000 })
})
