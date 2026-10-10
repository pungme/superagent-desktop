import { test, expect, _electron as electron } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A real agent using the Mac, start to finish, with nothing of the user's
 * touched: it is asked, from the dot, to press a button and fill a field in an
 * app of the test's own whose window is off every screen. It has to ask to use
 * the Mac, be told yes in the dot, read the controls, and act on them by name.
 *
 * The accessibility actions are aimed at that app by COVE_E2E_AX_PID; the
 * pointer and keyboard are never used. Real Claude turns — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/computer-act-live.spec.ts
 */
const LIVE = process.env.CLAUDE_LIVE === '1'
const helper = join(__dirname, '..', 'native', 'cuse')

test('a real agent asks, is allowed, reads the controls and acts on them by name', async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  test.skip(!existsSync(helper), 'the helper is not built here')
  const front = spawnSync('/usr/bin/lsappinfo', ['front']).stdout?.toString().trim() ?? ''
  test.skip(
    /com\.apple\.loginwindow/.test(
      spawnSync('/usr/bin/lsappinfo', ['info', '-only', 'bundleid', front]).stdout?.toString() ?? ''
    ),
    'this Mac is locked: nothing can be done on it, by design'
  )
  test.setTimeout(360_000)
  const dir = mkdtempSync(join(tmpdir(), 'cove-actlive-'))
  const data = mkdtempSync(join(tmpdir(), 'cove-actlive-data-'))
  const built = spawnSync('/usr/bin/clang', [
    '-fobjc-arc',
    '-framework',
    'Cocoa',
    '-o',
    join(dir, 'ax-target'),
    join(__dirname, 'fixtures', 'ax-target.m')
  ])
  expect(built.status, String(built.stderr)).toBe(0)
  const target = spawn(join(dir, 'ax-target'))
  let log = ''
  target.stdout.on('data', (d) => (log += String(d)))
  await expect.poll(() => /READY pid=(\d+)/.exec(log)?.[1] ?? '').not.toBe('')
  const pid = /READY pid=(\d+)/.exec(log)![1]
  const proj = join(dir, 'proj')
  spawnSync('/bin/mkdir', ['-p', proj])
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: data,
      COVE_E2E_PROJECT: proj,
      COVE_E2E_DOT: '1',
      COVE_E2E_AX_PID: pid,
      NODE_ENV: 'production'
    }
  })
  try {
    await expect.poll(() => app.windows().length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2)
    const dot = app.windows().find((p) => p.url().endsWith('#dot'))!
    const main = app.windows().find((p) => !p.url().endsWith('#dot'))!
    await main.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await main.reload()
    await main.waitForSelector('.sidebar', { timeout: 20_000 })
    expect((await main.evaluate(() => window.cove.setComputerUse(true))).enabled).toBe(true)
    await dot.waitForSelector('.dot-tile', { timeout: 20_000 })
    await dot.locator('.dot-tile').click()
    const panel = dot.getByRole('dialog', { name: 'Ask Superagent' })
    await panel
      .locator('.dot-input')
      .fill(
        'Use the Mac for this, with computer_read_ui (no screenshot is needed, and none is available): in the window in front there is a button called "Press" and a text field called "Name". Press the button once, then put the text "Ada Lovelace" in the Name field, using computer_press and computer_fill. Then tell me in one line what you did.'
      )
    await panel.locator('.dot-input').press('Enter')

    // Whatever it asks (to use the Mac; to work in the app in front), say yes
    // in the dot, as the user would, and note what was asked.
    const asked: string[] = []
    const allow = panel.getByRole('button', { name: 'Allow' })
    const open = panel.getByRole('button', { name: /Open in Superagent/ })
    await expect
      .poll(
        async () => {
          if (await allow.isVisible().catch(() => false)) {
            asked.push((await panel.locator('.dot-approval').innerText()).replace(/\s+/g, ' '))
            await allow.click()
            await dot.waitForTimeout(500)
          }
          // Finished without doing it: stop waiting and say what it said. (A
          // password manager's window open on this Mac is one honest reason:
          // computer use will not look at the screen while it is.)
          if (
            (await open.isVisible().catch(() => false)) &&
            !(log.includes('PRESSED') && log.includes('FIELD Ada Lovelace'))
          )
            throw new Error(
              'The agent finished without acting: ' +
                (await panel.locator('.dot-answer').innerText()).replace(/\s+/g, ' ').slice(0, 500)
            )
          return log.includes('PRESSED') && log.includes('FIELD Ada Lovelace')
        },
        { timeout: 240_000, intervals: [700] }
      )
      .toBe(true)
    await expect(open).toBeVisible({ timeout: 120_000 })
    console.log('ASKED:', asked.join(' || '))
    console.log('SAID:', (await panel.locator('.dot-answer').innerText()).replace(/\s+/g, ' '))
    console.log('STEPS:', (await panel.locator('.dot-step').allInnerTexts()).join(' | '))
    // It was asked before anything happened, and the first ask was for the Mac itself.
    expect(asked.length).toBeGreaterThanOrEqual(1)
    expect(asked[0]).toContain('Use this Mac')
    // Pressed once, in the background, and the password it was not asked about is as it was.
    expect((log.match(/PRESSED/g) ?? []).length).toBe(1)
    expect(log).toContain('PRESSED active=0')
    expect(log.split('\n').filter(Boolean).pop()).toContain('SECRET hunter2')
  } finally {
    target.kill()
    await app.close()
    for (const d of [dir, data]) rmSync(d, { recursive: true, force: true })
  }
})
