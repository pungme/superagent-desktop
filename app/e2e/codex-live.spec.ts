import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'

/**
 * The Codex backend, driven through the real app.
 *
 * Spends tokens and needs a signed-in `codex`, so it is opt-in:
 *
 *   npm run build && CODEX_LIVE=1 npx playwright test e2e/codex-live.spec.ts
 */

const LIVE = process.env.CODEX_LIVE === '1'

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  test.skip(!LIVE, 'set CODEX_LIVE=1 to run against the real codex CLI')
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-codex-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-codex-proj-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'README.md'), '# codex e2e project\n')

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
  // A seeded project starts with no conversations, and the app only opens one
  // when you ask for it — so the composer this suite drives needs a chat first.
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    await window.cove.chatCreate(ws.id)
  })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
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

test('the agent picker sits under the composer and switches the chat to Codex', async () => {
  const pill = window.locator('.easy-control-btn:has(.easy-control-key:text-is("Agent"))').first()
  await expect(pill).toBeVisible({ timeout: 10_000 })
  // Claude Code is the default, and every existing chat's agent.
  await expect(pill.locator('.easy-control-val')).toHaveText('Claude Code')

  await pill.click()
  const menu = window.locator('.easy-control-menu:visible')
  await expect(menu.locator('.easy-control-item-label')).toHaveText(['Claude Code', 'Codex'])
  await menu.locator('.easy-control-item:has-text("Codex")').click()
  await expect(pill.locator('.easy-control-val')).toHaveText('Codex')
})

test('a Codex turn streams a reply and really edits the file', async () => {
  writeFileSync(join(projectDir, 'greeting.txt'), 'hello world\n')
  const input = window.locator('textarea.easy-input:visible')
  await input.click()
  await input.fill(
    'In greeting.txt, change the word "world" to "codex". Then reply with exactly: DONE.'
  )
  await input.press('Enter')

  // The reply lands in the transcript — the whole point of the translation layer
  // is that this is the same chat UI Claude's events drive.
  await expect(window.locator('.easy-msg.easy-assistant').last()).toContainText('DONE', {
    timeout: 180_000
  })
  // The work shows as steps in the same collapsed summary Claude's turns use —
  // Codex may reach for the shell or a patch, so assert the summary, not which.
  const steps = window.locator('.easy-toolgroup .easy-tools-count').last()
  await expect(steps).toBeVisible({ timeout: 10_000 })
  await expect(steps).toContainText('step')
  expect(readFileSync(join(projectDir, 'greeting.txt'), 'utf8')).toContain('codex')
})

test('the chat keeps its agent across a reload', async () => {
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  const pill = window.locator('.easy-control-btn:has(.easy-control-key:text-is("Agent"))').first()
  await expect(pill.locator('.easy-control-val')).toHaveText('Codex', { timeout: 10_000 })
})
