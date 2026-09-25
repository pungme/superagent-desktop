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

let app: ElectronApplication
let window: Page
let userDataDir: string
let folderDir: string

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-add-folder-data-'))
  folderDir = mkdtempSync(join(tmpdir(), 'cove-added-folder-'))
  mkdirSync(folderDir, { recursive: true })
  writeFileSync(join(folderDir, 'README.md'), '# added folder\n')

  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: {
      ...process.env,
      COVE_USER_DATA: userDataDir,
      COVE_E2E_PICK_FOLDER: folderDir,
      NODE_ENV: 'production'
    }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, folderDir]) rmSync(dir, { recursive: true, force: true })
})

test('adding a code folder creates one usable root chat without a nested row', async () => {
  // The folder button on the Projects header (a fresh install has no groups, whose
  // headers carry the older "New project" button).
  await window.click('.sidebar-head-actions button[title="Add a project"]')
  await expect(window.locator('.sidebar-item', { hasText: 'cove-added-folder-' })).toBeVisible()

  const chats = await window.evaluate(async () => {
    return (
      window as unknown as { cove: { chatListAll: () => Promise<unknown[]> } }
    ).cove.chatListAll()
  })

  expect(chats).toHaveLength(1)
  await expect(window.getByRole('textbox', { name: /Message Claude/ })).toBeVisible()
  await expect(window.locator('[data-chat-id]')).toHaveCount(0)
  await expect(window.getByText('no branch yet')).toHaveCount(0)
})
