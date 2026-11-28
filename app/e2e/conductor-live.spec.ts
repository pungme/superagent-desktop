import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'

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
      // Main, from the sidebar's Conductor section: the Conductor view.
      await page.getByTestId('sidebar-conductor-row').first().click()
      await expect(page.getByTestId('conductor-main-here')).toBeVisible({ timeout: 20_000 })
      const input = page.locator('textarea.easy-input:visible').first()
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
      // Main, from the sidebar's Conductor section: the Conductor view.
      await page.getByTestId('sidebar-conductor-row').first().click()
      await expect(page.getByTestId('conductor-main-here')).toBeVisible({ timeout: 20_000 })
      const input = page.locator('textarea.easy-input:visible').first()
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

for (const agent of AGENTS)
  test(`${agent}: a follow-up goes to the session it belongs to, a different task starts a new one`, async () => {
    test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real agents')
    test.setTimeout(420_000)
    const data = mkdtempSync(join(tmpdir(), 'cove-condlive3-data-'))
    const proj = mkdtempSync(join(tmpdir(), 'cove-condlive3-proj-'))
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
        await window.cove.conductorSetRouting(w.id, 'auto')
        return w.id
      })
      await page.reload()
      await page.waitForSelector('.sidebar', { timeout: 20_000 })
      // Main, from the sidebar's Conductor section: the Conductor view.
      await page.getByTestId('sidebar-conductor-row').first().click()
      await expect(page.getByTestId('conductor-main-here')).toBeVisible({ timeout: 20_000 })
      const input = page.locator('textarea.easy-input:visible').first()
      await expect(input).toBeVisible({ timeout: 20_000 })
      const state = (): Promise<{ ticket: number | null; chatId: string }[]> =>
        page.evaluate(
          async (id) =>
            ((await window.cove.conductorGet(id))?.sessions ?? []).map((s) => ({
              ticket: s.ticket,
              chatId: s.chatId
            })),
          ws
        )
      const send = async (text: string): Promise<void> => {
        await input.fill(text)
        await input.press('Enter')
      }

      await send('Add a dark mode toggle to the settings page. Start a session for it.')
      await expect
        .poll(async () => (await state()).map((s) => s.ticket), {
          timeout: 180_000,
          intervals: [3000]
        })
        .toEqual([101])
      const first = (await state())[0].chatId
      // Let Main finish its turn before the next message.
      await page.waitForTimeout(15_000)

      // A follow-up about the same work: it goes to #101, no new session.
      await send('Also make the dark mode toggle remember the choice after a restart.')
      await expect
        .poll(
          () =>
            // The worker has been spoken to twice: its brief, and the follow-up (in Main's own words).
            page.evaluate(
              async (id) => ((await window.cove.conductorPeek(id)).match(/USER:/g) ?? []).length,
              first
            ),
          { timeout: 180_000, intervals: [3000] }
        )
        .toBeGreaterThanOrEqual(2)
      expect((await state()).map((s) => s.ticket)).toEqual([101])
      await page.waitForTimeout(15_000)

      // Something else entirely: a second session.
      await send('Separately, translate the pricing page into German. Start a session for that.')
      await expect
        .poll(async () => (await state()).map((s) => s.ticket), {
          timeout: 180_000,
          intervals: [3000]
        })
        .toEqual([101, 102])
    } catch (e) {
      const w = app.windows()[0]
      if (w) {
        await w
          .screenshot({
            path: join(process.env.SHOT ?? tmpdir(), `conductor-live-${agent}-routing-failed.png`)
          })
          .catch(() => undefined)
        console.log(
          'STATE',
          JSON.stringify(
            await w
              .evaluate(async () => {
                const tree = await window.cove.storeTree()
                const id = tree
                  .flatMap((g) => g.workspaces)
                  .find((x) => x.name === 'e2e-project')!.id
                return (await window.cove.conductorGet(id))?.sessions
              })
              .catch(() => null)
          )
        )
      }
      throw e
    } finally {
      await app.close()
      for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

for (const agent of AGENTS)
  test(`${agent}: work on the same file as a running session is not started in parallel: Main asks`, async () => {
    test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real agents')
    test.setTimeout(420_000)
    const data = mkdtempSync(join(tmpdir(), 'cove-condlive4-data-'))
    const proj = mkdtempSync(join(tmpdir(), 'cove-condlive4-proj-'))
    writeFileSync(join(proj, 'README.md'), '# demo\n')
    for (const args of [
      ['init', '-q', '-b', 'main'],
      ['add', '.'],
      ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']
    ])
      execFileSync('git', ['-C', proj, ...args])
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
        await window.cove.conductorSetRouting(w.id, 'auto')
        return w.id
      })
      await page.reload()
      await page.waitForSelector('.sidebar', { timeout: 20_000 })
      // Main, from the sidebar's Conductor section: the Conductor view.
      await page.getByTestId('sidebar-conductor-row').first().click()
      await expect(page.getByTestId('conductor-main-here')).toBeVisible({ timeout: 20_000 })
      const input = page.locator('textarea.easy-input:visible').first()
      await expect(input).toBeVisible({ timeout: 20_000 })
      const state = (): Promise<{ ticket: number | null; chatId: string }[]> =>
        page.evaluate(
          async (id) =>
            ((await window.cove.conductorGet(id))?.sessions ?? []).map((s) => ({
              ticket: s.ticket,
              chatId: s.chatId
            })),
          ws
        )
      const send = async (text: string): Promise<void> => {
        await input.fill(text)
        await input.press('Enter')
      }

      await send('Add a dark mode toggle to the settings page. Start a session for it.')
      await expect
        .poll(async () => (await state()).map((s) => s.ticket), {
          timeout: 180_000,
          intervals: [3000]
        })
        .toEqual([101])
      await page.waitForTimeout(15_000)
      // #101 is mid-way through settings.html (uncommitted, as a working session would be).
      const cwd = await page.evaluate(
        async (id) => (await window.cove.chatList(id)).find((c) => c.ticketNumber === 101)?.cwd,
        ws
      )
      expect(cwd).toBeTruthy()
      writeFileSync(join(cwd as string, 'settings.html'), '<h1>Settings</h1>\n')
      await send('Also restyle the headings in settings.html. Start a session for it right away.')
      // Main should hold off: no #102, and it says why or asks.
      await page.waitForTimeout(90_000)
      expect((await state()).map((s) => s.ticket)).toEqual([101])
      const said = await page.locator('.easy-chat:visible').first().innerText()
      // It says why: the work belongs with the session already on that file (named by its title,
      // never by an internal number).
      expect(said).toMatch(/already|same file|settings\.html|wait|add (it|this) to|instead/i)
      expect(said).not.toMatch(/#10\d/)
    } catch (e) {
      const w = app.windows()[0]
      if (w) {
        await w
          .screenshot({
            path: join(process.env.SHOT ?? tmpdir(), `conductor-live-${agent}-overlap-failed.png`)
          })
          .catch(() => undefined)
        console.log(
          'STATE',
          JSON.stringify(
            await w
              .evaluate(async () => {
                const tree = await window.cove.storeTree()
                const id = tree
                  .flatMap((g) => g.workspaces)
                  .find((x) => x.name === 'e2e-project')!.id
                return (await window.cove.conductorGet(id))?.sessions
              })
              .catch(() => null)
          )
        )
      }
      throw e
    } finally {
      await app.close()
      for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
    }
  })

for (const agent of AGENTS)
  test(`${agent}: Main saves what it is told and answers from its saved memory after a clean restart`, async () => {
    test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real agents')
    test.setTimeout(420_000)
    const data = mkdtempSync(join(tmpdir(), 'cove-condmem-data-'))
    const proj = mkdtempSync(join(tmpdir(), 'cove-condmem-proj-'))
    writeFileSync(join(proj, 'README.md'), '# demo\n')
    const launch = (): ReturnType<typeof electron.launch> =>
      electron.launch({
        args: [join(__dirname, '..', 'out', 'main', 'index.js')],
        env: {
          ...process.env,
          COVE_USER_DATA: data,
          COVE_E2E_PROJECT: proj,
          NODE_ENV: 'production'
        }
      })
    const memory = (): string => {
      try {
        return execFileSync(
          'sqlite3',
          [join(data, 'cove.db'), 'SELECT key || ": " || text FROM conductor_memory'],
          {
            encoding: 'utf8'
          }
        )
      } catch {
        return ''
      }
    }
    let app = await launch()
    try {
      let page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await page.evaluate(() => {
        localStorage.setItem('cove.onboarded', '1')
        localStorage.setItem('cove.connectionsOffered', '1')
      })
      await page.evaluate((a) => window.cove.kvSet('cove.provider', a), agent)
      const ids = await page.evaluate(async () => {
        const tree = await window.cove.storeTree()
        const w = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
        const st = await window.cove.conductorEnable(w.id, [])
        return { ws: w.id, main: st!.chatId }
      })
      await page.reload()
      await page.waitForSelector('.sidebar', { timeout: 20_000 })
      await page.getByTestId('sidebar-conductor-row').first().click()
      await expect(page.getByTestId('conductor-main-here')).toBeVisible({ timeout: 20_000 })
      let input = page.locator('textarea.easy-input:visible').first()
      await input.fill(
        'Remember this for later: our campaigns live in the database table t800_campaigns, with the fields id, status and deleted. Just save it; no session is needed.'
      )
      await input.press('Enter')
      await expect.poll(memory, { timeout: 180_000, intervals: [3000] }).toContain('t800_campaigns')

      // Main forgets the conversation: its chat is cleared and the app starts again.
      await page.waitForTimeout(8000)
      await page.evaluate((id) => window.cove.chatClear(id), ids.main)
      await app.close()
      app = await launch()
      page = await app.firstWindow()
      await page.waitForSelector('.sidebar', { timeout: 20_000 })
      await page.getByTestId('sidebar-conductor-row').first().click()
      await expect(page.getByTestId('conductor-main-here')).toBeVisible({ timeout: 20_000 })
      input = page.locator('textarea.easy-input:visible').first()
      await input.fill('Which database table holds our campaigns, and which fields does it have?')
      await input.press('Enter')
      await expect(page.locator('.easy-chat:visible').first()).toContainText('t800_campaigns', {
        timeout: 180_000
      })
    } finally {
      await app.close().catch(() => undefined)
      for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
    }
  })
