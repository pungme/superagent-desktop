import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * A real agent, asked to use "my browser" without naming one, moves the
 * project to the user's real browser itself (browser_use) — it used to answer
 * that it couldn't control Brave.
 *
 * A real Claude turn, so it spends a few tokens and needs a signed-in
 * `claude` — opt-in:
 *
 *   npm run build && CLAUDE_LIVE=1 npx playwright test e2e/browser-live.spec.ts
 */

const LIVE = process.env.CLAUDE_LIVE === '1'

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CLAUDE_LIVE=1 to run against the real claude CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-blive-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-blive-proj-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# browser e2e project\n')

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

test('asked to use "my browser", the agent switches to it by itself', async () => {
  const input = window.locator('textarea.easy-input:visible').first()
  await input.fill(
    'Can you use my own browser for this, since my Shopify login is there? Just open ' +
      'https://example.com in it and tell me the page title. Nothing else.'
  )
  await input.press('Enter')
  const wsId = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    return tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
  })
  await expect
    .poll(() => window.evaluate((id) => window.cove.browsersGet(id), wsId), { timeout: 180_000 })
    .not.toBe('builtin')
  await expect(window.locator('.easy-assistant:not(.easy-system)').last()).toContainText(
    /Example Domain/i,
    { timeout: 180_000 }
  )
  await expect(window.locator('.easy-assistant').last()).not.toContainText(/can.?t (control|use)/i)
})
