import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Keep working with the lid closed: off by default, and the switch only stays
 * on when macOS allowed it. (The system side is stood in for: a test run never
 * touches the real power settings.)
 */
test('lid-closed stay-awake is off by default and follows what macOS allowed', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-lid-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-lid-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const w = await app.firstWindow()
    await w.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await w.reload()
    await w.waitForSelector('.sidebar', { timeout: 20_000 })
    await w.click('.sidebar-settings[title="Settings"]')
    const row = w.locator('.settings-row', { hasText: 'Keep working with the lid closed' })
    const box = row.locator('input[type="checkbox"]')
    await expect(box).not.toBeChecked()

    // In a test run the real thing refuses: the switch goes back, and says why.
    await row.locator('.switch').click()
    await expect(w.getByRole('alert')).toContainText('Not available in a test run')
    await expect(box).not.toBeChecked()

    // Allowed: it stays on, and off again turns it off.
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { lid: boolean[] }
      g.lid = []
      ipcMain.removeHandler('power:set-lid-awake')
      ipcMain.handle('power:set-lid-awake', (_e, on: boolean) => {
        g.lid.push(on)
        return { ok: true, enabled: on }
      })
    })
    await row.locator('.switch').click()
    await expect(box).toBeChecked()
    await expect(w.getByRole('alert')).toHaveCount(0)
    await row.locator('.switch').click()
    await expect(box).not.toBeChecked()
    expect(await app.evaluate(() => (globalThis as unknown as { lid: boolean[] }).lid)).toEqual([
      true,
      false
    ])
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
