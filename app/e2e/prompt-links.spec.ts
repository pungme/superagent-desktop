import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'

/**
 * A superagent://prompt link opens a new chat with the prompt in its box, never
 * sent; "Diagnose Superagent" opens one on the Chats page with where the logs are.
 */
let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-e2e-links-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-e2e-links-proj-'))
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
  await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const dir of [userDataDir, projectDir]) rmSync(dir, { recursive: true, force: true })
})

/** As macOS hands a clicked link to the app. */
const openLink = (url: string): Promise<void> =>
  app.evaluate(({ app: a }, u) => {
    a.emit('open-url', { preventDefault: () => undefined }, u)
  }, url)

const box = (): ReturnType<Page['locator']> => window.locator('textarea.easy-input:visible')

test('a prompt link opens a chat in its project with the prompt drafted, not sent', async () => {
  const text = 'Make the header stick on phones.\nCheck it at 320pt.'
  await openLink(
    `superagent://prompt?text=${encodeURIComponent(text)}&project=${encodeURIComponent('e2e-project')}`
  )
  await expect(box()).toHaveValue(text, { timeout: 20_000 })
  // Not sent: no message of yours in the chat.
  await expect(window.locator('.easy-user:visible')).toHaveCount(0)
  const where = await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    return (await window.cove.chatList(ws.id)).length
  })
  expect(where).toBe(1)
})

test('a link that is not a prompt does nothing', async () => {
  await openLink('superagent://settings?text=hi')
  await window.waitForTimeout(800)
  await expect(box()).toHaveValue(/Make the header stick/)
})

test('Diagnose Superagent opens a chat of its own with where to look', async () => {
  await window.evaluate(() => window.cove.diagnoseOpen())
  await expect(box()).toHaveValue(/Diagnose Superagent .* for me\./, { timeout: 20_000 })
  const v = await box().inputValue()
  expect(v).toContain('agents.log')
  expect(v).toContain('phone-diagnostics')
  expect(v).toContain('https://github.com/pungme/superagent-desktop/tree/v')
  expect(v.trimEnd().endsWith('What went wrong:')).toBe(true)
  await expect(window.locator('.easy-user:visible')).toHaveCount(0)
})
