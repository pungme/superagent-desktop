import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A finger on the simulator must not wait behind main. With main frozen for
 * 1.5 s (as a busy Superagent freezes it), a key sent over the pane's own line
 * to the input process comes back in well under that; the same key through
 * main waits the freeze out. SIM_LIVE=<udid of a booted device of your own>.
 */
const UDID = process.env.SIM_LIVE
test.skip(!UDID, 'SIM_LIVE=<udid> to run against a real simulator')

test('input reaches the device while main is busy', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-sim-lat-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-sim-lat-proj-'))
  writeFileSync(join(proj, 'README.md'), '# sim latency\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // Open the line and let the device's session come up.
    await page.evaluate((u) => window.cove.simInputDirect(u, { type: 'hello' }), UDID!)
    await expect
      .poll(
        () =>
          page.evaluate(
            (u) => window.cove.simInputDirect(u, { type: 'key', code: 'Escape' }),
            UDID!
          ),
        { timeout: 30_000 }
      )
      .not.toBeNull()

    const timed = (direct: boolean): Promise<number> =>
      page.evaluate(
        async ({ u, direct }) => {
          // Let main's freeze begin first.
          await new Promise((r) => setTimeout(r, 200))
          const t = performance.now()
          const action = { type: 'key', code: 'Escape' }
          const r = direct
            ? await window.cove.simInputDirect(u, action)
            : await window.cove.simInput(u, action)
          if (!r?.ok) throw new Error(`not sent: ${JSON.stringify(r)}`)
          return performance.now() - t
        },
        { u: UDID!, direct }
      )
    const freeze = (): Promise<void> =>
      app.evaluate(() => {
        const end = Date.now() + 1500
        while (Date.now() < end) {
          /* main is busy */
        }
      })

    const [directMs] = await Promise.all([timed(true), freeze()])
    const [mainMs] = await Promise.all([timed(false), freeze()])
    console.log(
      JSON.stringify({ directMs: Math.round(directMs), throughMainMs: Math.round(mainMs) })
    )
    expect(directMs).toBeLessThan(300)
    expect(mainMs).toBeGreaterThan(directMs)
  } finally {
    await app.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
