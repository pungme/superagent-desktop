import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page
} from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * What is typed and not sent is still there after quitting, per conversation,
 * and a draft written elsewhere (the phone) shows up in the composer.
 */
let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

async function launch(): Promise<void> {
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
}

async function openChat(chatId: string): Promise<void> {
  await window.click('.sidebar-item:has-text("e2e-project")')
  await window.waitForSelector('.workspace-toolbar', { timeout: 10_000 })
  await window.click(`[data-chat-id="${chatId}"]`)
  await expect(window.locator('textarea.easy-input:visible')).toBeEnabled({ timeout: 20_000 })
}

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-drafts-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-drafts-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# e2e project\n')
  await launch()
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
})

test('a half-written message survives quitting, in the chat it was written in', async () => {
  const [first, second] = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
    await window.cove.chatCreate(wsId)
    await window.cove.chatCreate(wsId)
    return (await window.cove.chatListAll()).filter((c) => c.workspaceId === wsId).map((c) => c.id)
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })

  await openChat(first)
  const input = window.locator('textarea.easy-input:visible')
  await input.fill('half a sentence I have not sent')
  // Quit straight away, inside the pause before a draft is normally written.
  await app.close()

  await launch()
  await openChat(first)
  await expect(window.locator('textarea.easy-input:visible')).toHaveValue(
    'half a sentence I have not sent'
  )
  // The other conversation's composer is its own.
  await openChat(second)
  await expect(window.locator('textarea.easy-input:visible')).toHaveValue('')

  // Emptying it is remembered too.
  await openChat(first)
  await window.locator('textarea.easy-input:visible').fill('')
  await expect.poll(() => window.evaluate((id) => window.cove.draftGet(id), first)).toBe('')
})

test('a draft written elsewhere appears, unless you are typing', async () => {
  const chatId = await window.evaluate(
    async () => (await window.cove.chatListAll()).find((c) => c.workspaceId)!.id
  )
  await openChat(chatId)
  const input = window.locator('textarea.easy-input:visible')
  await expect(input).toHaveValue('')

  // As the phone would: the app is told, and tells the window.
  const fromPhone = (text: string): Promise<void> =>
    app.evaluate(
      ({ BrowserWindow }, d) => {
        for (const w of BrowserWindow.getAllWindows()) w.webContents.send('draft:changed', d)
      },
      { chatId, text }
    )
  await fromPhone('started on the phone')
  await expect(input).toHaveValue('started on the phone')

  // Mid-sentence here, the phone's older words do not replace it.
  await input.pressSequentially(' and continued here')
  await fromPhone('something stale')
  await expect(input).toHaveValue('started on the phone and continued here')
  await expect
    .poll(() => window.evaluate((id) => window.cove.draftGet(id), chatId))
    .toBe('started on the phone and continued here')
})
