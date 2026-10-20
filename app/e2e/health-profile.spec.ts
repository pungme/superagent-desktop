import { test, expect, _electron as electron } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A window that stays hot gets looked inside: main attaches to it, profiles
 * five seconds of JavaScript and writes the hottest functions to memory.log.
 * Two workers spinning put the window well past the threshold.
 */
test('a window burning more than a core is profiled and the profile named', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-hot-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-hot-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      NODE_ENV: 'production',
      // A page can burn one core at most; the real bar is more than one.
      COVE_HOT_RENDERER_PERCENT: '60'
    }
  })
  try {
    const window = await app.firstWindow()
    // Burn the window's own thread, ~90% of a core, for as long as the test runs.
    await window.evaluate(() => {
      const spin = (): void => {
        const end = performance.now() + 90
        let x = 0
        while (performance.now() < end) x = (x * 1103515245 + 12345) % 2147483648
      }
      ;(window as unknown as { hot: number }).hot = window.setInterval(spin, 100)
    })
    const log = join(data, 'memory.log')
    await expect
      .poll(() => (existsSync(log) ? readFileSync(log, 'utf8') : ''), { timeout: 90_000 })
      .toMatch(/profile pid=\d+ url=\S+ busy \d+% of \d+ms: .+=\d+ms/)
    const line = readFileSync(log, 'utf8')
      .split('\n')
      .find((l) => l.includes('profile pid='))!
    // The spin is the hottest thing in the profile, and it is named.
    expect(line).toMatch(/spin/)
    const files = readdirSync(join(data, 'diagnostics')).filter((f) => f.endsWith('.cpuprofile'))
    expect(files.length).toBe(1)
    expect(
      JSON.parse(readFileSync(join(data, 'diagnostics', files[0]), 'utf8')).nodes.length
    ).toBeGreaterThan(1)
  } finally {
    try {
      console.log(
        'MEMORY.LOG>>\n' +
          readFileSync(join(data, 'memory.log'), 'utf8')
            .split('\n')
            .filter((l) => /hot|profile|sys/.test(l))
            .join('\n')
      )
    } catch {
      /* no log */
    }
    await window_safe_close(app)
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})

async function window_safe_close(app: Awaited<ReturnType<typeof electron.launch>>): Promise<void> {
  try {
    await app.close()
  } catch {
    /* spinning workers can make the close slow; the process is killed by the harness */
  }
}
