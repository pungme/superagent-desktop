import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * A message held to send after the agent finishes sits between the
 * conversation and the composer, in its own room. It used to float over the
 * conversation's last lines, covering the newest message and "Working".
 *
 * A real Claude turn, so it spends a few tokens — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/queued-live.spec.ts
 */

const LIVE = process.env.CLAUDE_LIVE === '1'

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-queued-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-queued-proj-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# queued e2e project\n')

  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
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
  await window.waitForSelector('textarea.easy-input', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
})

test('a queued message takes its own room instead of covering the chat', async () => {
  const input = window.locator('textarea.easy-input:visible').first()
  await input.fill(
    'Run `python3 -c "import time; [time.sleep(1) for _ in range(20)]; print(20)"` in the ' +
      'foreground and wait for it, then reply with just the number.'
  )
  await input.press('Enter')
  await window.waitForTimeout(4000)

  await input.fill('can u also fix this')
  await window.getByRole('button', { name: 'Send message' }).click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Send when it finishes' }).click()
  const chip = window.locator('.easy-queued-item:visible')
  await expect(chip).toContainText('can u also fix this')

  // The conversation ends where the chip begins: nothing is underneath it.
  const scroll = (await window.locator('.easy-scroll:visible').first().boundingBox())!
  const box = (await chip.boundingBox())!
  expect(box.y).toBeGreaterThanOrEqual(scroll.y + scroll.height - 1)
  // And the conversation is still scrolled to its newest line.
  const gap = await window
    .locator('.easy-scroll:visible')
    .first()
    .evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)
  expect(gap).toBeLessThan(4)

  // It goes out by itself once the agent finishes.
  await expect(chip).toHaveCount(0, { timeout: 120_000 })
  await expect(window.locator('.easy-user').last()).toContainText('can u also fix this')
})
