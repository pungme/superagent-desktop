import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * A first launch opens on the reel's intro (public/intro), over the app while
 * it checks for Claude and Codex, then hands over to whatever is ready. Test
 * runs don't get it unless they ask (COVE_E2E_INTRO).
 */

async function launch(): Promise<{ app: ElectronApplication; window: Page; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'cove-intro-'))
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: dir, COVE_E2E_INTRO: '1', NODE_ENV: 'production' }
  })
  const window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  return { app, window, dir }
}

test('a first launch plays the intro, then hands over to the app, once', async () => {
  const { app, window, dir } = await launch()
  try {
    await expect(window.locator('.first-run-intro iframe')).toBeVisible({ timeout: 10_000 })
    const intro = window.frameLocator('.first-run-intro iframe')
    await expect(intro.locator('#stage')).toBeVisible()
    await expect(window.locator('.first-run-intro')).toHaveCount(0, { timeout: 35_000 })
    await expect(window.locator('.sidebar, .onboarding')).toBeVisible()
    expect(await window.evaluate(() => localStorage.getItem('cove.firstRunIntroSeen'))).toBe('1')
    // Not again on the next launch.
    await window.reload()
    await window.waitForTimeout(800)
    await expect(window.locator('.first-run-intro')).toHaveCount(0)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Skip ends it at once', async () => {
  const { app, window, dir } = await launch()
  try {
    const intro = window.frameLocator('.first-run-intro iframe')
    await intro.locator('#skip').click({ timeout: 10_000 })
    await expect(window.locator('.first-run-intro')).toHaveCount(0, { timeout: 3_000 })
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
