import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The bug as it happened on the user's Mac: the window's localStorage held a
 * stale copy of `dot.enabled=1`. The dot was switched off (main saved 0), and
 * the next window to load wrote the 1 back. Main's settings must survive any
 * window loading, whatever its storage holds.
 */
test('a stale copy in the window cannot switch the dot back on', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-stale-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-stale-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const kv = (key: string): string =>
    execFileSync('/usr/bin/sqlite3', [
      join(data, 'cove.db'),
      `SELECT value FROM kv WHERE key='${key}'`
    ])
      .toString()
      .trim()
  const app: ElectronApplication = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    // On, as the user once had it; then an old build's copy lands in the window.
    await page.evaluate(() => window.cove.setDotEnabled(true))
    await page.evaluate(() => {
      Object.getPrototypeOf(Object.getPrototypeOf(localStorage)).setItem
      Storage.prototype.setItem.call(localStorage, 'dot.enabled', '1')
      Storage.prototype.setItem.call(localStorage, 'computer.enabled', '1')
    })
    // Off in Settings: main saves 0.
    await page.evaluate(() => window.cove.setDotEnabled(false))
    expect(kv('dot.enabled')).toBe('0')
    // Any window loading — after an update, a reopened window, a reload.
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.waitForTimeout(1000)
    expect(kv('dot.enabled')).toBe('0')
    expect(kv('computer.enabled')).toBe('')
    expect(await page.evaluate(() => localStorage.getItem('dot.enabled'))).toBeNull()
    // The window's own settings still go through.
    await page.evaluate(() => localStorage.setItem('cove.theme', 'dark'))
    await page.waitForTimeout(300)
    expect(kv('cove.theme')).toBe('dark')
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
