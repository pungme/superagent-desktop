import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A quit that is called off must leave the app whole. The cleanup (phone link,
 * agents, routines) used to run on before-quit, which fires before the save
 * guard decides — so "Keep open" left an app with no phone link and no agents,
 * and the phone said "Mac asleep" until the next restart.
 */
test('a quit kept open leaves the app working, and a later quit still goes', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-keep-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-keep-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      NODE_ENV: 'production',
      COVE_E2E_QUIT_ANSWER: 'keep',
      COVE_E2E_DOT: '1'
    }
  })
  try {
    await app.firstWindow()
    await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2)
    // The app window, not the dot (which this test hangs).
    const page = app.windows().find((p) => !p.url().endsWith('#dot'))!
    await page.waitForLoadState('domcontentloaded')
    // Something the cleanup tears down: a routine ticker and the companion.
    const before = await app.evaluate(({ app }) => app.getAppMetrics().length)
    // Hang the dot's window (its preload joins the flush): the guard gets a
    // straggler and asks, and the app window stays usable to check on.
    await expect.poll(() => app.windows().some((p) => p.url().endsWith('#dot'))).toBe(true)
    await app.evaluate(({ BrowserWindow }) => {
      const dot = BrowserWindow.getAllWindows().find((w) =>
        w.webContents.getURL().endsWith('#dot')
      )!
      void dot.webContents.executeJavaScript('setTimeout(() => { for (;;) {} }, 50); 0')
    })
    await new Promise((r) => setTimeout(r, 1200))
    let closed = false
    app.on('close', () => (closed = true))
    console.log('STAGE quitting')
    await app
      .evaluate(({ app }) => app.quit())
      .catch((e) => console.log('STAGE quit evaluate failed ' + e))
    console.log('STAGE quit asked')
    // The guard waits 15 s, asks, and the answer is Keep open.
    await new Promise((r) => setTimeout(r, 19_000))
    console.log('STAGE after wait closed=' + closed)
    expect(closed).toBe(false)
    // Whole: main and the window still answer, nothing of ours was torn down,
    // and the dot window is still there — the quit did nothing.
    const timed = async <T>(label: string, f: () => Promise<T>): Promise<T> => {
      const t = Date.now()
      const r = await Promise.race([
        f(),
        new Promise<T>((_, rej) => setTimeout(() => rej(new Error(label + ' hung')), 15_000))
      ])
      console.log(`STAGE ${label} ${Date.now() - t}ms`)
      return r
    }
    expect(
      await timed('windows', () =>
        app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
      )
    ).toBe(2)
    expect(
      await timed('storeTree', () =>
        page.evaluate(() => window.cove.storeTree().then((t) => Array.isArray(t)))
      )
    ).toBe(true)
    expect(
      await timed('metrics', () => app.evaluate(({ app }) => app.getAppMetrics().length))
    ).toBeGreaterThanOrEqual(before)
  } finally {
    const { readFileSync, existsSync } = await import('node:fs')
    if (existsSync(join(data, 'memory.log')))
      console.log(
        'LOG memory>>\n' +
          readFileSync(join(data, 'memory.log'), 'utf8')
            .split('\n')
            .filter((l) => /quit|stragg/i.test(l))
            .join('\n')
      )
    // The app would answer "Keep open" to the harness too: end it directly.
    app.process().kill('SIGKILL')
    await new Promise((r) => setTimeout(r, 500))
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
