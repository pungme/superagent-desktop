import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'

/**
 * How long the Conductor's list takes with a real number of sessions (22, each in its own git
 * worktree), and how often it blocks the app. Opt-in: PERF=1 npx playwright test e2e/perf.
 */
test('conductor list with 22 sessions stays fast', async () => {
  test.skip(process.env.PERF !== '1', 'set PERF=1')
  test.setTimeout(180_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-perf-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-perf-proj-'))
  const git = (...a: string[]): string =>
    execFileSync('git', ['-C', proj, ...a], { encoding: 'utf8' })
  git('init', '-q', '-b', 'main')
  writeFileSync(join(proj, 'a.txt'), 'a\n')
  git('add', '.')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  const dirs: string[] = []
  for (let i = 0; i < 22; i++) {
    const d = join(tmpdir(), `cove-perf-wt-${process.pid}-${i}`)
    git('worktree', 'add', '-q', '-b', `s${i}`, d)
    writeFileSync(join(d, `f${i}.txt`), 'x\n')
    dirs.push(d)
  }
  const app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    const ws = await page.evaluate(async (paths) => {
      const tree = await window.cove.storeTree()
      const w = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
      const ids: string[] = []
      for (const p of paths) {
        const id = await window.cove.chatCreate(w.id, p)
        await window.cove.chatUpdate(id, { title: `Session ${ids.length}` })
        ids.push(id)
      }
      await window.cove.conductorEnable(w.id, ids)
      return w.id
    }, dirs)
    const t = await page.evaluate(async (id) => {
      const times: number[] = []
      for (let i = 0; i < 5; i++) {
        const a = performance.now()
        await window.cove.conductorGet(id)
        times.push(Math.round(performance.now() - a))
      }
      const o: number[] = []
      for (let i = 0; i < 5; i++) {
        const a = performance.now()
        await window.cove.conductorOverview()
        o.push(Math.round(performance.now() - a))
      }
      return { get: times, overview: o }
    }, ws)
    // With the view open on 22 sessions for a while: how long is the main process ever stuck?
    await app.evaluate(() => {
      // A 10 ms timer: how late it ever fires is how long the main process was stuck.
      const st = { last: Date.now(), max: 0, late: 0, n: 0 }
      setInterval(() => {
        const now = Date.now()
        const gap = now - st.last - 10
        st.last = now
        st.n++
        if (gap > st.max) st.max = gap
        if (gap > 50) st.late++
      }, 10)
      ;(globalThis as unknown as { __lag: typeof st }).__lag = st
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.getByTestId('sidebar-conductor-row').first().click()
    await expect(page.getByTestId('conductor-session').first()).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(12_000)
    const lag = await app.evaluate(() => {
      const st = (globalThis as unknown as { __lag: { max: number; late: number; n: number } })
        .__lag
      return { maxMs: st.max, stallsOver50ms: st.late, ticks: st.n }
    })
    console.log('PERF main-process lag with the view open', JSON.stringify(lag))
    expect(lag.maxMs).toBeLessThan(400)
    console.log(
      'PERF conductorGet ms',
      JSON.stringify(t.get),
      'overview ms',
      JSON.stringify(t.overview)
    )
    expect(t.get.length).toBe(5)
  } finally {
    await app.close()
    for (const d of [data, proj, ...dirs]) rmSync(d, { recursive: true, force: true })
  }
})
