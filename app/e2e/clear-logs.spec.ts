import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The app's own logs are nothing the user needs, and one memory snapshot can
 * be gigabytes: Settings says what they are and clears them, and only them.
 */
test('Settings clears the logs and a memory snapshot, and nothing else', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-logs-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-logs-proj-'))
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
    const snapshot = join(data, 'diagnostics', 'main-then.heapsnapshot')
    mkdirSync(join(data, 'diagnostics'), { recursive: true })
    writeFileSync(snapshot, Buffer.alloc(3 * 1024 * 1024))
    writeFileSync(join(data, 'pane-debug.log.old'), 'old lines\n')

    await page.click('.sidebar-settings[title="Settings"]')
    await page.getByRole('button', { name: 'Advanced', exact: false }).click()
    const row = page.locator('.storage-row', { hasText: 'Logs' })
    await expect(row).toContainText('MB', { timeout: 15_000 })
    await expect(row).toContainText('nothing of yours')
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-clear-logs.png' })
    await row.getByRole('button', { name: 'Clear', exact: true }).click()
    await expect.poll(() => existsSync(snapshot)).toBe(false)
    expect(existsSync(join(data, 'pane-debug.log.old'))).toBe(false)
    // Measured again, and no longer megabytes.
    await expect(row).not.toContainText('MB', { timeout: 15_000 })
    // The conversations are where they were.
    expect(existsSync(join(data, 'cove.db'))).toBe(true)
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
