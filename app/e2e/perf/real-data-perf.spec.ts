import { test, _electron as electron } from '@playwright/test'
import { join } from 'path'

/**
 * Start-up and idle cost on a COPY of a real, large store (COVE_PERF_DATA = a folder holding copies
 * of cove.db and transcripts.sqlite). Opt-in; it only reads the copy and never looks at chat text.
 */
test('start-up and idle on a real, large store', async () => {
  const data = process.env.COVE_PERF_DATA
  test.skip(!data, 'set COVE_PERF_DATA to a folder with copies of cove.db and transcripts.sqlite')
  test.setTimeout(180_000)
  const t0 = Date.now()
  const app = await electron.launch({
    args: [join(__dirname, '..', '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data!, NODE_ENV: 'production' }
  })
  try {
    // From the first moment: a 10 ms timer, to see how long the main process is ever stuck.
    await app.evaluate(() => {
      const st = { last: Date.now(), max: 0, late: 0, n: 0, worst: [] as number[] }
      setInterval(() => {
        const now = Date.now()
        const gap = now - st.last - 10
        st.last = now
        st.n++
        if (gap > st.max) st.max = gap
        if (gap > 50) {
          st.late++
          if (st.worst.length < 8) st.worst.push(gap)
        }
      }, 10)
      ;(globalThis as unknown as { __lag: typeof st }).__lag = st
    })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('.sidebar', { timeout: 60_000 })
    const toSidebar = Date.now() - t0
    await page.waitForSelector('.chat-tree-row, .sidebar-item', { timeout: 60_000 })
    const toRows = Date.now() - t0
    await page.waitForTimeout(8000)
    const lag = await app.evaluate(() => {
      const st = (globalThis as unknown as { __lag: Record<string, unknown> }).__lag
      return st
    })
    const m = await app.evaluate(({ app: a }) =>
      a
        .getAppMetrics()
        .map((x) => ({ type: x.type, mb: Math.round((x.memory.workingSetSize ?? 0) / 1024) }))
    )
    console.log('PERFREAL to sidebar ms', toSidebar, 'to rows ms', toRows)
    console.log('PERFREAL main lag', JSON.stringify(lag))
    console.log('PERFREAL memory', JSON.stringify(m))
  } finally {
    await app.close()
  }
})
