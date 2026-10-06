import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Stop, then type: the cursor stays in the message box. Stopping restarts the
 * agent, and while it came back up the box was disabled, which dropped the
 * cursor of someone already typing their next message.
 *
 * A real Claude turn, so it spends a few tokens — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/stop-focus-live.spec.ts
 */
const LIVE = process.env.CLAUDE_LIVE === '1'

test('after Stop the message box keeps the cursor and takes typing', async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-stop-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-stop-proj-'))
  writeFileSync(join(proj, 'README.md'), '# stop\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      await window.cove.chatCreate(ws.id)
    })
    await window.click('.sidebar-item:has-text("e2e-project")')
    const input = window.locator('textarea.easy-input:visible').first()
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill('Write the numbers from 1 to 400, one per line. Nothing else.')
    await input.press('Enter')
    const stop = window.locator('.easy-stop:visible')
    await expect(stop).toBeVisible({ timeout: 30_000 })
    await input.click()
    await stop.click()
    // Sampled through the restart: never disabled, never without the cursor.
    const seen = await window.evaluate(async () => {
      const el = document.querySelector('textarea.easy-input') as HTMLTextAreaElement
      const out = { disabled: 0, unfocused: 0, samples: 0 }
      for (let i = 0; i < 60; i++) {
        out.samples++
        if (el.disabled) out.disabled++
        if (document.activeElement !== el) out.unfocused++
        await new Promise((r) => setTimeout(r, 50))
      }
      return out
    })
    console.log('STOP', JSON.stringify(seen))
    expect(seen.disabled).toBe(0)
    expect(seen.unfocused).toBe(0)
    await window.keyboard.type('next thing')
    await expect(input).toHaveValue('next thing')
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
