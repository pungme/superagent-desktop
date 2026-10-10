import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Two ways to hold computer use closer, both off until asked for: every step
 * put to the user first, and screenshots that show only the allowed apps.
 * Here: the switches are there once computer use is on, they take, and they
 * are still set after the window is loaded again. Nothing on the Mac is used.
 */
test('ask-before-each-step and only-the-allowed-apps can be turned on, and stay on', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-cuset-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-cuset-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const status = await page.evaluate(() => window.cove.setComputerUse(true))
    test.skip(!status.enabled, 'computer use is a Mac feature')
    expect(status.steps).toBe(false)
    expect(status.focused).toBe(false)

    await page.click('.sidebar-settings[title="Settings"]')
    const steps = page.locator('.settings-row', { hasText: 'Ask before each step' })
    const only = page.locator('.settings-row', { hasText: 'Show it only the apps you allowed' })
    await expect(steps.locator('input[type="checkbox"]')).not.toBeChecked()
    await expect(only.locator('input[type="checkbox"]')).not.toBeChecked()
    await steps.locator('.switch').click()
    await only.locator('.switch').click()
    await expect(steps.locator('input[type="checkbox"]')).toBeChecked()
    await expect(only.locator('input[type="checkbox"]')).toBeChecked()
    if (process.env.SHOT) await steps.scrollIntoViewIfNeeded()
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-computer-settings.png' })

    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const after = await page.evaluate(() => window.cove.computerStatus())
    expect(after).toMatchObject({ enabled: true, steps: true, focused: true })
    await page.click('.sidebar-settings[title="Settings"]')
    await expect(steps.locator('input[type="checkbox"]')).toBeChecked()
    await steps.locator('.switch').click()
    expect((await page.evaluate(() => window.cove.computerStatus())).steps).toBe(false)
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
