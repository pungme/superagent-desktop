import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every chat renders in the sidebar exactly once — by IDENTITY, not by text.
 *
 * 1.8.2 shipped every conversation twice: the sidebar's two views (branch
 * rows for projects with worktrees, the plain all-chats list without) were
 * mutually exclusive by design, and a change that didn't see the second view
 * stacked extra rows on top of it. The test that let it through asserted the
 * new markup existed rather than counting what a user sees; this one counts
 * rows per chat id, which catches both directions — a chat with no row
 * (invisible) and a chat with two (doubled) — whatever the markup looks like.
 */
let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-proj-'))
  mkdirSync(projectDir, { recursive: true })
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
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
})

test('a project with no conversation says so and offers one', async () => {
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
  // It used to be a blank page with nothing to type into.
  const empty = window.locator('.project-empty:visible')
  await expect(empty).toContainText('No conversation in e2e-project yet.')
  await empty.getByRole('button', { name: '+ New chat' }).click()
  await expect(window.locator('textarea.easy-input:visible')).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('.project-empty:visible')).toHaveCount(0)
  // The chat it made is removed again, so the next test starts from none.
  await window.evaluate(async () => {
    for (const c of await window.cove.chatListAll()) await window.cove.chatDelete(c.id)
  })
})

test('every chat has exactly one sidebar row', async () => {
  // A new project starts with no conversation (the app only opens one when
  // asked), so make all three here.
  const ids = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
    for (let i = 0; i < 3; i++) await window.cove.chatCreate(wsId)
    return (await window.cove.chatListAll()).filter((c) => c.workspaceId === wsId).map((c) => c.id)
  })
  expect(ids.length).toBe(3)

  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.waitForSelector('[data-chat-id]', { timeout: 10_000 })

  const perChat = await window.evaluate((chatIds: string[]) => {
    return chatIds.map((id) => ({
      id,
      rows: document.querySelectorAll(`[data-chat-id="${id}"]`).length
    }))
  }, ids)
  // Exactly one row each: 0 is the invisible-chat bug, 2+ is the 1.8.2 doubling.
  expect(perChat.filter((c) => c.rows !== 1)).toEqual([])
})
