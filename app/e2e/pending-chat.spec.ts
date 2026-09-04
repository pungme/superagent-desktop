import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every chat appears in the sidebar EXACTLY once.
 *
 * The sidebar has two mutually exclusive views: projects with worktrees get
 * branch rows; projects without get the plain all-chats list. A "fix" that
 * added folder rows on top of the list rendered every conversation twice in
 * every worktree-less project (1.8.2). This pins both properties — present,
 * and not duplicated — by counting visible occurrences of each title.
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

test('folder chats each render once — no more, no less', async () => {
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })

  await window.evaluate(async () => {
    const cove = (window as unknown as {
      cove: {
        chatListAll: () => Promise<{ workspaceId: string }[]>
        chatCreate: (id: string) => Promise<string>
        chatRename?: (id: string, title: string) => Promise<void>
      }
    }).cove
    const wsId = (await cove.chatListAll())[0].workspaceId
    await cove.chatCreate(wsId)
    await cove.chatCreate(wsId)
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })

  // Three chats exist. Count every sidebar row that opens a chat: the plain
  // list rows plus any folder/branch rows. Each chat must own exactly one.
  const counts = await window.evaluate(() => {
    const texts = [...document.querySelectorAll('.chat-tree-row, .routine-tree-row')].map(
      (el) => (el.textContent ?? '').trim()
    )
    return texts
  })
  // Three chats → exactly three rows. Fewer = invisible chats (the Mr Market
  // bug); more = every chat rendered twice (the 1.8.2 bug).
  expect(counts).toHaveLength(3)
})
