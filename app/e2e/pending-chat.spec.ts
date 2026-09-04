import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
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
    env: { ...process.env, COVE_USER_DATA: userDataDir, COVE_E2E_PROJECT: projectDir, NODE_ENV: 'production' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
})

test('every chat has exactly one sidebar row', async () => {
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })

  const ids = await window.evaluate(async () => {
    const cove = (window as unknown as {
      cove: {
        chatListAll: () => Promise<{ id: string; workspaceId: string }[]>
        chatCreate: (id: string) => Promise<string>
      }
    }).cove
    const wsId = (await cove.chatListAll())[0].workspaceId
    await cove.chatCreate(wsId)
    await cove.chatCreate(wsId)
    return (await cove.chatListAll()).filter((c) => c.workspaceId === wsId).map((c) => c.id)
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
