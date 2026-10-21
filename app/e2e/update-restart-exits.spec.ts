import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Restart to update must end the process, whatever state a window is in. The
 * user spent six hours on a build that could not: a hung web view, a quit the
 * save guard called off, and a fallback that never fired.
 */
test('Restart to update ends the process even with a hung window', async () => {
  test.setTimeout(60_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-restart-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-restart-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      NODE_ENV: 'production',
      COVE_E2E_FAKE_STAGED: '1'
    }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await app.evaluate(({ BrowserWindow }) => {
      void BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        'setTimeout(() => { for (;;) {} }, 50); 0'
      )
    })
    await new Promise((r) => setTimeout(r, 1000))
    console.log('STAGE hung, asking install')
    const t0 = Date.now()
    const closed = app.waitForEvent('close', { timeout: 30_000 })
    await app
      .evaluate(({ ipcMain }) => ipcMain.emit('update:install'))
      .catch((e) => console.log('STAGE emit failed ' + e))
    console.log('STAGE emitted after ' + (Date.now() - t0) + 'ms')
    void closed.then(() => console.log('STAGE closed after ' + (Date.now() - t0) + 'ms'))
    await closed
    // The save flush (8 s cap) plus the 1.2 s fallback, with margin.
    expect(Date.now() - t0).toBeLessThan(20_000)
  } finally {
    const { readFileSync, existsSync } = await import('node:fs')
    for (const f of ['updater.log', 'memory.log'])
      if (existsSync(join(data, f)))
        console.log(
          'LOG ' +
            f +
            '>>\n' +
            readFileSync(join(data, f), 'utf8')
              .split('\n')
              .filter((l) => /install|forc|quit|still|exit|stragg|error/i.test(l))
              .slice(-12)
              .join('\n')
        )
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
