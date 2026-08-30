import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'

/**
 * A folder that is not a repo. It has no branches and can never have any, but it
 * still has conversations — and for a while it rendered nothing at all, because
 * the branch list had swallowed the chat list. This is that regression, nailed
 * down.
 *
 * Prereq: `npm run build`.
 */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

const newChat = async (): Promise<void> => {
  const id = await window.evaluate(() => localStorage.getItem('activeWorkspace'))
  await app.evaluate(({ BrowserWindow }, wsId) => {
    BrowserWindow.getAllWindows()[0].webContents.send('workspace:menu-action', {
      action: 'new-chat',
      id: wsId
    })
  }, id)
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-plain-'))
  mkdirSync(projectDir, { recursive: true })
  writeFileSync(join(projectDir, 'notes.md'), '# just a folder\n')

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
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
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

test('the project opens and is usable', async () => {
  await expect(window.locator('textarea.easy-input')).toBeVisible()
})

test('no branch rows are offered — there is nothing to branch', async () => {
  await expect(window.locator('.sidebar-branch')).toHaveCount(0)
})

test('New Chat still works, and makes no worktree folder', async () => {
  await newChat()
  // Two chats now, so the rows show — this is the regression: the branch list
  // had replaced the chat list, so a non-git folder rendered no rows at all and
  // there was no way to reach a conversation.
  await expect.poll(() => window.locator('.chat-tree-row').count(), { timeout: 15_000 }).toBeGreaterThan(1)
  expect(existsSync(join(projectDir, '.worktrees'))).toBe(false)
})

test('those chats can still be renamed', async () => {
  await window.locator('.chat-tree-row').first().dblclick()
  const rename = window.locator('input.chat-tree-rename')
  await expect(rename).toBeVisible()
  await rename.fill('plain folder chat')
  await rename.press('Enter')
  await expect(window.locator('.chat-tree-row', { hasText: 'plain folder chat' })).toBeVisible()
})

test('no branch chip is shown when the folder has no branch', async () => {
  await expect(window.locator('.chat-tree-wt')).toHaveCount(0)
})
