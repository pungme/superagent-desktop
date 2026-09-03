import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every chat must be visible the moment it exists.
 *
 * The real case (the user's "Mr Market", a plain folder — not a git repo):
 * right-click → New chat created chats that rendered NOWHERE. The project row
 * represents the folder's first chat, and a folder chat beyond the first —
 * no cwd, no pending flag — matched no sidebar category at all. The phone
 * lists chats straight from the database, so it showed three while the Mac
 * showed one, and "new chat did nothing" was the same bug from the other end.
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
  // Deliberately NOT a git repo — that is the shape that reproduced it.
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

test('second and third folder chats appear in the sidebar', async () => {
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })

  // What right-click → New chat does on a non-repo project: a chat in the
  // folder, no branch to wait for. Twice, like the user did.
  await window.evaluate(async () => {
    const cove = (window as unknown as {
      cove: {
        chatListAll: () => Promise<{ workspaceId: string }[]>
        chatCreate: (id: string) => Promise<string>
      }
    }).cove
    const wsId = (await cove.chatListAll())[0].workspaceId
    await cove.chatCreate(wsId)
    await cove.chatCreate(wsId)
  })
  // A fresh render must learn about them from the database alone.
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  await expect(window.locator('.routine-tree :text("in the folder")')).toHaveCount(2, {
    timeout: 10_000
  })
})
