import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Settings → Agents → Simulators: the ones agents left behind, biggest first, cleared by
 * hand or by the switch. The main handlers are stood in for, so no real simulator is
 * ever touched; what the window asks them to delete is recorded.
 */
test('the simulator list shows size and why one is kept, and deletes what is picked', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-sim-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-sim-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
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
    await app.evaluate(({ ipcMain }) => {
      const day = 86_400_000
      const g = globalThis as unknown as { deleted: string[][]; auto: boolean[] }
      g.deleted = []
      g.auto = []
      let rows = [
        {
          udid: 'A',
          name: 'iPhone Duo',
          state: 'Booted',
          sizeBytes: 14e9,
          lastUsedAt: Date.now(),
          keep: 'running',
          removable: false
        },
        {
          udid: 'B',
          name: 'iPhone Duo (11)',
          state: 'Shutdown',
          sizeBytes: 9e9,
          lastUsedAt: Date.now() - 12 * day,
          keep: 'baseline',
          removable: true
        },
        {
          udid: 'C',
          name: 'Fold Audit',
          state: 'Shutdown',
          sizeBytes: 3e9,
          lastUsedAt: Date.now() - 9 * day,
          keep: null,
          removable: true
        },
        {
          udid: 'D',
          name: 'SD Phone 69',
          state: 'Shutdown',
          sizeBytes: 2e9,
          lastUsedAt: Date.now() - 1 * day,
          keep: 'recent',
          removable: true
        }
      ]
      let auto = true
      ipcMain.removeHandler('sim:cleanup-state')
      ipcMain.handle('sim:cleanup-state', () => ({
        rows,
        totalBytes: rows.reduce((n, r) => n + r.sizeBytes, 0),
        auto
      }))
      ipcMain.removeHandler('sim:cleanup-delete')
      ipcMain.handle('sim:cleanup-delete', (_e, udids: string[]) => {
        g.deleted.push(udids)
        const gone = rows.filter((r) => udids.includes(r.udid))
        rows = rows.filter((r) => !udids.includes(r.udid))
        return {
          deleted: gone.length,
          freedBytes: gone.reduce((n, r) => n + r.sizeBytes, 0),
          skipped: 0
        }
      })
      ipcMain.removeHandler('sim:cleanup-auto')
      ipcMain.handle('sim:cleanup-auto', (_e, on: boolean) => {
        g.auto.push(on)
        auto = on
        return on
      })
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-settings[title="Settings"]')
    await page.click('.settings-nav-item:has-text("Agents")')

    const rows = page.locator('.settings-sim-row')
    await expect(rows).toHaveCount(4)
    await expect(rows.nth(0)).toContainText('iPhone Duo')
    await expect(rows.nth(0)).toContainText('14 GB')
    await expect(rows.nth(0)).toContainText('running')
    await expect(rows.nth(0).locator('input')).toBeDisabled()
    await expect(rows.nth(2)).toContainText('Fold Audit')
    await expect(rows.nth(2)).toContainText('3.0 GB')
    await page.locator('.settings-sim-actions').scrollIntoViewIfNeeded()
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-sim.png' })

    // "Unused for a week" picks the two that are, not the one used yesterday or the running one.
    await page.getByRole('button', { name: /Select the 2 unused/ }).click()
    await expect(rows.nth(1).locator('input')).toBeChecked()
    await expect(rows.nth(2).locator('input')).toBeChecked()
    await expect(rows.nth(3).locator('input')).not.toBeChecked()
    page.once('dialog', (d) => void d.accept())
    await page.getByRole('button', { name: /^Delete 2/ }).click()
    await expect(rows).toHaveCount(2)
    await expect(page.locator('.settings-sim-note')).toContainText('Deleted 2, freed 12 GB')
    expect(
      await app.evaluate(() => (globalThis as unknown as { deleted: string[][] }).deleted)
    ).toEqual([['B', 'C']])

    // The switch is remembered by main.
    await page
      .locator('.settings-row', { hasText: 'Clear out unused simulators' })
      .locator('.switch')
      .click()
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { auto: boolean[] }).auto))
      .toEqual([false])
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
