import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
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

test('Settings lists Antigravity with how to install it and sign in', async () => {
  await window.click('.sidebar-settings[title="Settings"]')
  await window.click('.settings-nav-item:has-text("Agents")')
  await expect(window.locator('.settings-accounts')).toBeVisible()
  const account = window.locator('.settings-accounts-provider', { hasText: 'Antigravity' })
  await expect(account.locator('.settings-account').first()).toContainText('Your Antigravity login')
})
