import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { chmodSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * Antigravity is the third agent a chat can run on. This covers what the window
 * owes it without needing the CLI signed in: it is offered beside the other two,
 * picking it sticks to the chat, and its own sign-in shows up under Agents.
 * (The backend itself is covered by the unit tests in src/main/antigravity.)
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-agy-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-agy-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# e2e project\n')
  // A stand-in `agy` that lists models the way the real one does: a status line,
  // then slug<TAB>name, slowly (the real CLI takes seconds, longer than a session
  // waits for it at start).
  const agy = join(userDataDir, 'agy')
  writeFileSync(
    agy,
    '#!/bin/sh\nif [ "$1" = models ]; then sleep 2; echo "Fetching available models..."; ' +
      'printf "gemini-4-neon-high\\tGemini 4 Neon (High)\\ngemini-4-neon-low\\tGemini 4 Neon (Low)\\n' +
      'gpt-oss-120b-medium\\tGPT-OSS 120B (Medium)\\n"; exit 0; fi\nexit 1\n'
  )
  chmodSync(agy, 0o755)
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PROJECT: projectDir,
      COVE_E2E_AGY_BIN: agy,
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  // The seed has no conversation, and without one there is no composer.
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    await window.cove.chatCreate(ws.id)
    localStorage.setItem('cove.onboarded', '1')
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
})

const agentPill = (): ReturnType<Page['locator']> =>
  window.locator('.easy-control-btn[title="Which agent runs this chat"]')

test('the agent picker offers Antigravity beside Claude Code and Codex', async () => {
  await agentPill().click()
  const items = window.locator('.easy-control-menu .easy-control-item-label')
  await expect(items).toHaveText(['Claude Code', 'Codex', 'Antigravity'])
  const antigravity = window.locator('.easy-control-menu .easy-control-item', {
    hasText: 'Antigravity'
  })
  // Its own mark, not one of the other two.
  await expect(antigravity.locator('svg path')).toHaveAttribute('d', /^M21\.751 22\.607/)
  await expect(antigravity).toContainText("Google's agent")
  await window.keyboard.press('Escape')
})

test('picking Antigravity moves the chat onto it, and it stays there', async () => {
  if (!(await window.locator('.easy-control-menu').isVisible())) await agentPill().click()
  await window.locator('.easy-control-menu .easy-control-item', { hasText: 'Antigravity' }).click()
  await expect(agentPill()).toContainText('Antigravity')
  // The chat's own record, which is what main reads to decide which CLI to start.
  const provider = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    const chats = await window.cove.chatList(ws.id)
    return chats[0]?.provider
  })
  expect(provider).toBe('antigravity')
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await expect(agentPill()).toContainText('Antigravity')
})

test('an Antigravity chat offers its models before it has run, each once with its efforts', async () => {
  // The chat is on Antigravity from the test before. No message sent: no session.
  const modelBtn = window.locator('.easy-control-btn[title="Model"]')
  await expect(async () => {
    await modelBtn.click()
    await expect(window.locator('.easy-model-efforts')).toHaveCount(1, { timeout: 1000 })
  }).toPass({ timeout: 20_000 })
  const neon = window.locator('.easy-model-efforts', { hasText: 'Gemini 4 Neon' })
  await expect(neon.locator('.easy-effort-chip')).toHaveText(['Low', 'High'])
  await expect(window.locator('.easy-control-menu')).toContainText('GPT-OSS 120B')
  await neon.getByRole('button', { name: 'High' }).click()
  await expect(modelBtn).toContainText('Gemini 4 Neon · High')
})

test('Settings lists Antigravity with how to install it and sign in', async () => {
  await window.click('.sidebar-settings[title="Settings"]')
  await window.click('.settings-nav-item:has-text("Agents")')
  await expect(window.locator('.settings-accounts')).toBeVisible()
  const account = window.locator('.settings-accounts-provider', { hasText: 'Antigravity' })
  await expect(account.locator('.settings-account').first()).toContainText('Your Antigravity login')
})
