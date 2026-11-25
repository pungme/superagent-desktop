import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The routines overview: every project's routines on one page, failed ones
 * first, what they cost from their own runs, and changing one in place.
 * Routines and runs are put straight into the database; nothing is run.
 */
test('routines overview: all routines, failures first, cost, edit in place', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-rov-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-rov-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const db = join(data, 'cove.db')
  const sql = (q: string): string => execFileSync('sqlite3', [db, q]).toString().trim()
  const launch = (): Promise<ElectronApplication> =>
    electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
    })
  const HOUR = 3_600_000
  try {
    // First start creates the schema and the project.
    let app = await launch()
    let page = await app.firstWindow()
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const ws = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      return tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!.id
    })
    await app.close()

    const now = Date.now()
    const add = (
      id: string,
      prompt: string,
      status: string | null,
      interval: number,
      enabled = 1
    ): void => {
      sql(
        `INSERT INTO routines (id, workspaceId, workspacePath, prompt, intervalMs, enabled, nextRunAt, lastRunAt, lastRunStatus, lastRunSummary, runCount, lastRunTokens)
         VALUES ('${id}', '${ws}', '${proj}', '${prompt}', ${interval}, ${enabled}, ${now + interval}, ${status ? now - 600_000 : 'NULL'}, ${status ? `'${status}'` : 'NULL'}, ${status === 'error' ? "'Login expired'" : 'NULL'}, ${status ? 3 : 0}, ${status ? 10000 : 0})`
      )
    }
    const run = (
      id: string,
      routine: string,
      ago: number,
      status: string,
      tokens: number
    ): void => {
      sql(
        `INSERT INTO routine_runs (id, routineId, startedAt, endedAt, status, tokens, summary) VALUES ('${id}', '${routine}', ${now - ago}, ${now - ago + 1000}, '${status}', ${tokens}, '${status === 'ok' ? 'Updated 12 rows' : 'Login expired'}')`
      )
    }
    add('r-ok', 'Update the metrics sheet', 'ok', HOUR)
    add('r-bad', 'Fetch the signup numbers', 'error', 2 * HOUR)
    add('r-new', 'Never run yet', null, HOUR)
    run('a1', 'r-ok', 600_000, 'ok', 10_000)
    run('a2', 'r-ok', 4_200_000, 'ok', 20_000)
    run('b1', 'r-bad', 600_000, 'error', 5_000)

    app = await launch()
    page = await app.firstWindow()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })

    // The way in is in the sidebar, with the failed count.
    const row = page.getByTestId('sidebar-routines')
    await expect(row).toContainText('1 failed', { timeout: 10_000 })
    await row.click()
    const overview = page.getByTestId('routines-overview')
    await expect(overview).toBeVisible()
    await expect(overview).toContainText('3 routines')
    await expect(overview).toContainText('1 failed')

    // Failed first, then the rest.
    const cards = page.getByTestId('routine-card')
    await expect(cards).toHaveCount(3)
    await expect(cards.nth(0)).toContainText('Fetch the signup numbers')
    await expect(cards.nth(0)).toContainText('Login expired')

    // Cost from the runs: (10k + 20k) / 2 = 15k a run, 168 runs a week = 2.5M.
    await expect(cards.filter({ hasText: 'Update the metrics sheet' })).toContainText(
      'about 15k per run · 2.5M a week'
    )
    // Nothing is guessed for a routine that never ran.
    await expect(cards.filter({ hasText: 'Never run yet' })).toContainText(
      'cost unknown until it has run'
    )

    // History.
    const ok = page.locator('[data-routine-id="r-ok"]')
    await ok.getByRole('button', { name: /Runs \(2\)/ }).click()
    await expect(ok).toContainText('Updated 12 rows')

    // Slowing it down says what it saves, and counts from now.
    await ok.getByLabel('How often').selectOption('1440')
    await expect(ok).toContainText('Saves about 2.4M tokens a week')
    await expect(ok.getByTestId('routine-cost')).toContainText('105k a week')
    expect(sql("SELECT intervalMs FROM routines WHERE id = 'r-ok'")).toBe(String(24 * HOUR))
    expect(Number(sql("SELECT nextRunAt FROM routines WHERE id = 'r-ok'"))).toBeGreaterThan(
      Date.now() + 23 * HOUR
    )

    // Editing what it does, in place.
    await ok.getByTitle('Edit what it does').click()
    await ok.locator('textarea').fill('Only fetch the new rows')
    await ok.getByRole('button', { name: 'Save' }).click()
    await expect(ok).toContainText('Only fetch the new rows')
    expect(sql("SELECT prompt FROM routines WHERE id = 'r-ok'")).toBe('Only fetch the new rows')

    // Escape leaves the words alone.
    await ok.getByTitle('Edit what it does').click()
    await ok.locator('textarea').fill('Something else')
    await ok.locator('textarea').press('Escape')
    await expect(ok).toContainText('Only fetch the new rows')

    // Pausing takes it out of the week.
    await ok.getByTitle('Pause').click()
    await expect(ok).toContainText('paused')
    await expect(ok.getByTestId('routine-cost')).not.toContainText('a week')
    expect(sql("SELECT enabled FROM routines WHERE id = 'r-ok'")).toBe('0')
    await app.close()
  } finally {
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
