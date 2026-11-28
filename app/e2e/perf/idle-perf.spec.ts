import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/** What the app costs doing nothing: CPU of every process over ten idle seconds, and the start-up. */
test('idle cost and start-up', async () => {
  test.skip(process.env.PERF !== '1', 'set PERF=1')
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-idle-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-idle-proj-'))
  writeFileSync(join(proj, 'README.md'), '# idle\n')
  const t0 = Date.now()
  const app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const startMs = Date.now() - t0
    await page.waitForTimeout(4000) // let start-up work settle
    const sample = (): Promise<{ type: string; cpu: number; mb: number }[]> =>
      app.evaluate(({ app: a }) =>
        a.getAppMetrics().map((m) => ({
          type: m.type,
          cpu: m.cpu.cumulativeCPUUsage ?? 0,
          mb: Math.round((m.memory.workingSetSize ?? 0) / 1024)
        }))
      )
    const a = await sample()
    await page.waitForTimeout(10_000)
    const b = await sample()
    const rows = b.map((m, i) => ({
      type: m.type,
      cpuPercentOverTenSeconds: Math.round(((m.cpu - (a[i]?.cpu ?? 0)) / 10) * 1000) / 10,
      mb: m.mb
    }))
    console.log('PERF start-up to sidebar ms', startMs)
    console.log('PERF idle', JSON.stringify(rows))
    expect(startMs).toBeLessThan(15_000)
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
