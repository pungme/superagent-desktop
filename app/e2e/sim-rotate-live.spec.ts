import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The simulator turns when asked, on Xcode 27 as well (a GSEvent to
 * PurpleWorkspacePort, through siminput), and Superagent then reads it the way
 * it asked: left is left. Safari is opened first; the iPhone home screen never
 * turns. SIM_LIVE=<udid of a booted device of your own>.
 */
const UDID = process.env.SIM_LIVE
test.skip(!UDID, 'SIM_LIVE=<udid> to run against a real simulator')

test('the simulator turns left, right and back', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-sim-rot-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-sim-rot-proj-'))
  writeFileSync(join(proj, 'README.md'), '# sim rotate\n')
  execFileSync('xcrun', ['simctl', 'openurl', UDID!, 'https://example.com'])
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const turn = (value: string): Promise<{ ok: boolean; error?: string }> =>
      page.evaluate(({ u, value }) => window.cove.simInput(u, { type: 'orientation', value }), {
        u: UDID!,
        value
      })
    const facing = (): Promise<string | null> =>
      page.evaluate((u) => window.cove.simOrientation(u), UDID!)
    for (const [asked, seen] of [
      ['landscape-left', 'left'],
      ['landscape-right', 'right'],
      ['portrait', 'portrait']
    ] as const) {
      expect(await turn(asked)).toMatchObject({ ok: true })
      await expect.poll(facing, { timeout: 10_000 }).toBe(seen)
    }
  } finally {
    await app.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
