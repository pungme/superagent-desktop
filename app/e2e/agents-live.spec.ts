import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Background sub-agents stay visible until they report back. Their tool result
 * only says "launched", which used to clear the pill at once — an agent could
 * be waiting on six research agents with nothing on screen saying so.
 *
 * Real Claude turns, so it spends a few tokens — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/agents-live.spec.ts
 */

const LIVE = process.env.CLAUDE_LIVE === '1'

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-agents-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-agents-proj-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# agents e2e project\n')

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

test('a background agent keeps its pill until it reports back, even across a new message', async () => {
  const input = window.locator('textarea.easy-input:visible').first()
  await input.fill(
    'Launch one sub-agent with the Agent tool, run_in_background true, description "count sheep". ' +
      'Its prompt: "Count the sheep: run `python3 -c \\"import time; [time.sleep(1) for _ in range(25)]; print(25)\\"` ' +
      'in the foreground (not in the background) and wait for it, then reply with just the number". ' +
      "Don't wait for it: end your turn right after launching, with one short line."
  )
  await input.press('Enter')
  const pill = window.locator('.easy-run-agent', { hasText: 'count sheep' })
  await expect(pill).toBeVisible({ timeout: 120_000 })
  // The launching turn ends; the agent is still working, so the pill stays.
  await expect(window.locator('.easy-assistant:not(.easy-system)').last()).toBeVisible()
  await window.waitForTimeout(3000)
  await expect(pill).toBeVisible()
  // A new message doesn't sweep it away either.
  await input.fill('Reply with just: ok')
  await input.press('Enter')
  await window.waitForTimeout(3000)
  await expect(pill).toBeVisible()
  // Its completion clears it.
  await expect(pill).toHaveCount(0, { timeout: 120_000 })
})
