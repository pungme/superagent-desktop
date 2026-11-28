import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Settings → Advanced → Compact conversations: it measures the free space, and a compaction asked
 * for runs on the next start, before the stores open; the app comes up as normal and says what it
 * did. (The button's own restart is a native dialog and a relaunch; here the request is made the
 * same way it does, by the flag file, and the app started again.)
 */
test('compacting the conversation store on the next start', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-compact-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-compact-proj-'))
  writeFileSync(join(proj, 'README.md'), '# c\n')
  const launch = (): ReturnType<typeof electron.launch> =>
    electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
    })
  let app = await launch()
  try {
    let page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    // Fill the store and empty it again: the space stays inside the file.
    await page.evaluate(async () => {
      const big = 'x'.repeat(200_000)
      for (let i = 0; i < 60; i++) await window.cove.kvSet(`bulk:${i}`, big)
      for (let i = 0; i < 60; i++) await window.cove.kvSet(`bulk:${i}`, '')
    })
    const space = await page.evaluate(() => window.cove.storageSpace())
    const free = space.find((s) => s.file === 'cove.db')?.freeBytes ?? 0
    expect(free).toBeGreaterThan(1_000_000)
    // Settings → Advanced shows it, with the button.
    await page.click('.sidebar-settings[title="Settings"]')
    await page.click('.settings-nav-item:has-text("Advanced")')
    const row = page.getByTestId('storage-compact')
    await expect(row).toContainText('can be given back', { timeout: 20_000 })
    await expect(row.getByRole('button', { name: 'Compact…' })).toBeEnabled()
    if (process.env.SHOT)
      await row.screenshot({ path: join(process.env.SHOT, 'storage-compact.png') })
    await app.close()
    const before = statSync(join(data, 'cove.db')).size

    // Asked for: the app starts again and compacts first.
    writeFileSync(join(data, 'compact-on-start'), String(Date.now()))
    app = await launch()
    // The first window is the small "Compacting…" one; the app's own comes after it.
    await expect
      .poll(
        () => app.windows().some((w) => !w.isClosed() && !/^(data:|about:blank)/.test(w.url())),
        { timeout: 60_000 }
      )
      .toBe(true)
    page = app.windows().find((w) => !w.isClosed() && !/^(data:|about:blank)/.test(w.url()))!
    await page.waitForSelector('.sidebar', { timeout: 60_000 })
    expect(existsSync(join(data, 'compact-on-start'))).toBe(false)
    const result = await page.evaluate(() => window.cove.storageCompactResult())
    expect(result).not.toBeNull()
    expect(result!.failed).toBeUndefined()
    expect(statSync(join(data, 'cove.db')).size).toBeLessThan(before)
    const after = await page.evaluate(() => window.cove.storageSpace())
    expect(after.find((s) => s.file === 'cove.db')?.freeBytes ?? 0).toBeLessThan(free)
  } finally {
    await app.close().catch(() => undefined)
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
