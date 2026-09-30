import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

/**
 * A standalone chat keeps working while you are in another session. The Chats
 * page was unmounted when you left it, which stopped its agent mid-turn.
 *
 * A real Claude turn, so it spends a few tokens — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/chats-live.spec.ts
 */

const LIVE = process.env.CLAUDE_LIVE === '1'
let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-chatslive-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-chatslive-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# chats live\n')
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
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir]) if (d) rmSync(d, { recursive: true, force: true })
})

test('a standalone chat finishes its turn while you are in a project', async () => {
  await window.locator('.sidebar-chats-head button[aria-label="New chat"]').click()
  const input = window.locator('.chats-host textarea.easy-input:visible').first()
  await expect(input).toBeVisible({ timeout: 15_000 })
  await input.fill(
    'Run the shell command `sleep 12` and then reply with exactly the word FINISHED. Nothing else.'
  )
  // Sent with the button, on a brand-new chat (its agent starts on this send):
  // the cursor comes back to the composer either way.
  await window.locator('.chats-host').getByRole('button', { name: 'Send message' }).click()
  await expect(window.locator('.chats-host .easy-user').last()).toContainText('sleep 12')
  await expect
    .poll(() => input.evaluate((el) => document.activeElement === el), { timeout: 15_000 })
    .toBe(true)
  // Straight to a project while it works.
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(window.locator('.chats-host')).toBeHidden()
  // Still there, off screen, rather than torn down.
  await expect(window.locator('.chats-host .chat-mount')).toHaveCount(1)
  await window.waitForTimeout(25_000)
  // Back: the turn finished while we were away.
  await window.locator('.sidebar-chats .sidebar-chat-row').first().click()
  await expect(
    window.locator('.chats-host .easy-assistant:not(.easy-system)').last()
  ).toContainText('FINISHED', { timeout: 90_000 })
})
