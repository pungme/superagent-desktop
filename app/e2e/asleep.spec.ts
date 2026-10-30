import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Minimized, the window pauses its animations; restored, they run again. */
test('animations pause while the window is minimized', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-asleep-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-asleep-p-'))
  writeFileSync(join(proj, 'README.md'), '# e\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const asleep = (): Promise<boolean> =>
      page.evaluate(() => document.documentElement.classList.contains('app-asleep'))
    await expect.poll(asleep).toBe(false)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    await expect.poll(asleep).toBe(true)
    // The test window is never on screen, so it cannot be restored for real;
    // say what restoring says.
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send('app:window-visible', true)
    )
    await expect.poll(asleep).toBe(false)
  } finally {
    await app.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
