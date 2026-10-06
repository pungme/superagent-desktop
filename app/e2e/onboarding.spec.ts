import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Setting an agent up never leaves Superagent: one button installs it and
 * signs in, in a window of the app's own. It used to open Terminal, which
 * opened the browser, and then wait for a Re-check.
 */
test('one button installs an agent and signs it in, here', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-onb-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-onb-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // A Mac with nothing installed; installing and signing in are stood in for.
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as {
        sa: { installed: Set<string>; signedIn: Set<string>; signIns: string[]; refuse: boolean }
      }
      g.sa = { installed: new Set(), signedIn: new Set(), signIns: [], refuse: true }
      const one = (
        p: string
      ): { installed: boolean; loggedIn: boolean; version: string | null } => ({
        installed: g.sa.installed.has(p),
        loggedIn: g.sa.signedIn.has(p),
        version: g.sa.installed.has(p) ? '1.0.0' : null
      })
      ipcMain.removeHandler('env:detect')
      ipcMain.handle('env:detect', () => ({
        claude: one('claude'),
        codex: one('codex'),
        antigravity: one('antigravity'),
        loggedIn: g.sa.signedIn.has('claude'),
        claudeInstalled: g.sa.installed.has('claude'),
        claudeVersion: null
      }))
      ipcMain.removeHandler('env:install')
      ipcMain.handle('env:install', (_e, p: string) => {
        g.sa.installed.add(p)
        return { ok: true }
      })
      ipcMain.removeHandler('env:sign-in')
      ipcMain.handle('env:sign-in', (_e, p: string) => {
        g.sa.signIns.push(p)
        if (g.sa.refuse) return { ok: false, error: 'That account has no plan.' }
        g.sa.signedIn.add(p)
        return { ok: true }
      })
    })
    await page.evaluate(() => localStorage.removeItem('cove.onboarded'))
    await page.reload()

    const rows = page.locator('.onboarding-agent')
    await expect(rows).toHaveCount(3)
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeDisabled()
    // Nothing on the page sends you to Terminal or a browser.
    await expect(page.locator('.onboarding')).not.toContainText(/Terminal/i)
    await expect(page.locator('.onboarding a[href]')).toHaveCount(0)

    // A sign-in that fails says why, on that agent's row only, and the row
    // now offers Sign in: the install is done.
    const claude = rows.nth(0)
    await claude.getByRole('button', { name: 'Install', exact: true }).click()
    await expect(claude.getByRole('alert')).toContainText('That account has no plan.')
    await expect(rows.nth(1).getByRole('alert')).toHaveCount(0)
    await expect(claude.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible()

    // Then it works: connected, and Continue opens up.
    await app.evaluate(() => {
      ;(globalThis as unknown as { sa: { refuse: boolean } }).sa.refuse = false
    })
    await claude.getByRole('button', { name: 'Sign in', exact: true }).click()
    await expect(claude).toContainText('Connected')
    await expect(claude.getByRole('alert')).toHaveCount(0)
    expect(
      await app.evaluate(() => (globalThis as unknown as { sa: { signIns: string[] } }).sa.signIns)
    ).toEqual(['claude', 'claude'])
    await page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Connect your apps' })).toBeVisible()
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
