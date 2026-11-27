import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Conductor against a real Claude: in Auto, a clear task written to Main starts a numbered session,
 * and a question about status is answered in Main without starting another. A few real turns, so
 * opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/conductor-live.spec.ts
 */
const LIVE = process.env.CLAUDE_LIVE === '1'
// Which agents to try: CONDUCTOR_AGENTS=claude,codex,antigravity (default: claude).
const AGENTS = (process.env.CONDUCTOR_AGENTS ?? 'claude').split(',').map((a) => a.trim())

for (const agent of AGENTS)
  test(`${agent}: Main starts a session for a clear task, and answers a question itself`, async () => {
    test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real agents')
    test.setTimeout(300_000)
    const data = mkdtempSync(join(tmpdir(), 'cove-condlive-data-'))
    const proj = mkdtempSync(join(tmpdir(), 'cove-condlive-proj-'))
    writeFileSync(join(proj, 'README.md'), '# demo\n')
    const app = await electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.evaluate(() => {
        localStorage.setItem('cove.onboarded', '1')
        localStorage.setItem('cove.connectionsOffered', '1')
      })
      // The agent Main (and the sessions it starts) will run on.
      await page.evaluate((a) => window.cove.kvSet('cove.provider', a), agent)
      await page.waitForTimeout(500)
      const ws = await page.evaluate(async () => {
        const tree = await window.cove.storeTree()
        const w = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
        await window.cove.conductorEnable(w.id, [])
        await window.cove.conductorSetRouting(w.id, 'auto')
        return w.id
      })
      await page.reload()
      await page.waitForSelector('.sidebar', { timeout: 20_000 })
      await page.click('.sidebar-item:has-text("e2e-project")')
      // Main, from the Sessions tab.
      await page
        .locator('.tile-todo-btn:visible, .toolbar-btn[title="Todo"]:visible')
        .first()
        .click()
      await page.getByTestId('tab-sessions').click()
      await page.getByTestId('conductor-main').click()
      const input = page.locator('textarea.easy-input:visible')
      await expect(input).toBeVisible({ timeout: 20_000 })
      await input.fill(
        'Ticket WD-284: please add a dark mode toggle to the settings page of this app. Start a session for it.'
      )
      await input.press('Enter')

      // A session appears, numbered #101.
      await expect
        .poll(
          async () =>
            page.evaluate(
              async (id) => (await window.cove.conductorGet(id))?.sessions.map((s) => s.ticket),
              ws
            ),
          { timeout: 180_000, intervals: [3000] }
        )
        .toEqual([101])
      // Titled like a ticket, not like the request: short, with the tracker id the person gave.
      const title = await page.evaluate(
        async (id) => (await window.cove.conductorGet(id))?.sessions[0]?.title ?? '',
        ws
      )
      expect(title.split(/\s+/).length).toBeLessThanOrEqual(8)
      expect(title).toMatch(/WD-284/)
      // The Sessions tab shows it at once (Main's own tool told the window).
      await expect(page.getByTestId('conductor-session')).toHaveCount(1, { timeout: 3000 })
      await page.screenshot({
        path: join(process.env.SHOT ?? tmpdir(), `conductor-live-${agent}.png`)
      })

      // A question about where things stand is answered in Main, without a second session.
      await page.waitForTimeout(5000)
      await input.fill('Which sessions are running right now? Just answer, do not start anything.')
      await input.press('Enter')
      await expect(page.locator('.easy-messages, .easy-chat').first()).toContainText(
        /#101|dark mode/i,
        {
          timeout: 180_000
        }
      )
      const after = await page.evaluate(
        async (id) => (await window.cove.conductorGet(id))?.sessions.map((s) => s.ticket),
        ws
      )
      expect(after).toEqual([101])
    } catch (e) {
      // What Main said, for the report.
      const page = app.windows()[0]
      if (page)
        await page
          .screenshot({
            path: join(process.env.SHOT ?? tmpdir(), `conductor-live-${agent}-failed.png`)
          })
          .catch(() => undefined)
      throw e
    } finally {
      await app.close()
      for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

for (const agent of AGENTS)
  test(`${agent}: in Confirm, Main asks before starting a session, and starts it on a yes`, async () => {
    test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real agents')
    test.setTimeout(300_000)
    const data = mkdtempSync(join(tmpdir(), 'cove-condlive2-data-'))
    const proj = mkdtempSync(join(tmpdir(), 'cove-condlive2-proj-'))
    writeFileSync(join(proj, 'README.md'), '# demo\n')
    const app = await electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
    })
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.evaluate(() => {
        localStorage.setItem('cove.onboarded', '1')
        localStorage.setItem('cove.connectionsOffered', '1')
      })
      await page.evaluate((a) => window.cove.kvSet('cove.provider', a), agent)
      await page.waitForTimeout(500)
      const ws = await page.evaluate(async () => {
        const tree = await window.cove.storeTree()
        const w = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
        await window.cove.conductorEnable(w.id, [])
        return w.id // routing stays Confirm, the default
      })
      await page.reload()
      await page.waitForSelector('.sidebar', { timeout: 20_000 })
      await page.click('.sidebar-item:has-text("e2e-project")')
      await page
        .locator('.tile-todo-btn:visible, .toolbar-btn[title="Todo"]:visible')
        .first()
        .click()
      await page.getByTestId('tab-sessions').click()
      await page.getByTestId('conductor-main').click()
      const input = page.locator('textarea.easy-input:visible')
      await expect(input).toBeVisible({ timeout: 20_000 })
      const sessions = (): Promise<(number | null)[] | undefined> =>
        page.evaluate(
          async (id) => (await window.cove.conductorGet(id))?.sessions.map((s) => s.ticket),
          ws
        )

      await input.fill('I would like a dark mode toggle on the settings page of this app.')
      await input.press('Enter')
      // It answers (asks, or talks it over) and no session exists yet.
      await expect(page.locator('.easy-chat').first()).toContainText(
        /\?|session|confirm|shall|want me/i,
        {
          timeout: 180_000
        }
      )
      await page.waitForTimeout(8000)
      expect(await sessions()).toEqual([])

      await input.fill('Yes, go ahead and start it.')
      await input.press('Enter')
      await expect.poll(sessions, { timeout: 180_000, intervals: [3000] }).toEqual([101])
    } finally {
      await app.close()
      for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
    }
  })
