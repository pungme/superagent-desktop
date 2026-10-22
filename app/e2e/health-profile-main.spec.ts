import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The main process looks inside itself when it stays hot: it samples its own
 * JavaScript for four seconds and writes the hottest functions to memory.log,
 * with the full profile in diagnostics/. Here main is kept busy on purpose, and
 * the bar is lowered so a test machine's idle core count does not decide it.
 */
test('a main process that stays busy is profiled and the profile named', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-hotmain-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-hotmain-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      NODE_ENV: 'production',
      COVE_HOT_MAIN_PERCENT: '30'
    }
  })
  try {
    await app.firstWindow()
    // Keep main busy (~70% of a core) for as long as the test runs.
    await app.evaluate(() => {
      const busyMain = (): void => {
        const end = Date.now() + 70
        let x = 0
        while (Date.now() < end) x = (x * 1103515245 + 12345) % 2147483648
      }
      ;(globalThis as unknown as { hot: ReturnType<typeof setInterval> }).hot = setInterval(
        busyMain,
        100
      )
    })
    const log = join(data, 'memory.log')
    await expect
      .poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''), { timeout: 90_000 })
      .toMatch(/profile main busy \d+% of \d+ms: .+=\d+ms/)
    const line = readFileSync(log, 'utf8')
      .split('\n')
      .find((l) => l.includes('profile main'))!
    // The test's busy loop is injected code with no name of its own; it shows as
    // the timer that runs it, and it is the hottest thing in the profile.
    expect(line).toMatch(/busy \d+% of \d+ms: (busyMain|listOnTimeout)/)
    const files = readdirSync(join(data, 'diagnostics')).filter((f) => f.startsWith('main-'))
    expect(files.length).toBe(1)
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
