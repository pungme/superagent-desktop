import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Off in Settings, then Restart to update, then back: still off, and no dot. */
test('the dot turned off in Settings stays off across Restart to update', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-dotoff-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-dotoff-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const env = {
    ...process.env,
    COVE_USER_DATA: data,
    COVE_E2E_PROJECT: proj,
    NODE_ENV: 'production',
    COVE_E2E_DOT: '1'
  }
  const launch = (): Promise<ElectronApplication> =>
    electron.launch({ args: [join(__dirname, '..', 'out', 'main', 'index.js')], env })
  const kv = (): string =>
    execFileSync('/usr/bin/sqlite3', [
      join(data, 'cove.db'),
      "SELECT value FROM kv WHERE key='dot.enabled'"
    ])
      .toString()
      .trim()
  const dots = (app: ElectronApplication): Promise<number> =>
    app.evaluate(
      ({ BrowserWindow }) =>
        BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().endsWith('#dot')).length
    )

  let app = await launch()
  let pages = app.windows()
  await app.firstWindow()
  await new Promise((r) => setTimeout(r, 1500))
  pages = app.windows()
  const main = pages.find((p) => !p.url().endsWith('#dot'))!
  await main.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await main.reload()
  await main.waitForSelector('.sidebar', { timeout: 20_000 })
  expect(await dots(app)).toBe(1)
  await main.click('.sidebar-settings[title="Settings"]')
  const row = main.locator('.settings-row', { hasText: 'Show Superagent as a floating dot' })
  await expect(row.locator('input[type="checkbox"]')).toBeChecked()
  await row.locator('.switch').click()
  await expect(row.locator('input[type="checkbox"]')).not.toBeChecked()
  await expect.poll(() => dots(app)).toBe(0)
  expect(kv()).toBe('0')
  // The user's next move: Restart to update. Nothing staged here, so the app
  // takes its windows down and stays; we close it as the update would.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.emit('update:install')
  })
  await new Promise((r) => setTimeout(r, 2500))
  expect(kv()).toBe('0')
  await app.close().catch(() => {})
  app = await launch()
  await app.firstWindow()
  await new Promise((r) => setTimeout(r, 2500))
  expect(kv()).toBe('0')
  expect(await dots(app)).toBe(0)
  await app.close()
  for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
})
