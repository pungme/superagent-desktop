import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

/** ↑/↓ walk the sessions while the sidebar has the keyboard — and only then. */

let app: ElectronApplication
let window: Page
let userDataDir: string
let projectDir: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'cove-keys-data-'))
  projectDir = mkdtempSync(join(tmpdir(), 'cove-keys-proj-'))
  writeFileSync(join(projectDir, 'README.md'), '# keys\n')
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
  await window.evaluate(async () => {
    const tree = await window.cove.storeTree()
    const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
    for (const t of ['First session', 'Second session', 'Third session']) {
      const id = await window.cove.chatCreate(ws.id)
      await window.cove.chatUpdate(id, { title: t })
    }
  })
  await window.reload()
  await window.waitForSelector('.chat-tree-row', { timeout: 20_000 })
})

test.afterAll(async () => {
  await app?.close()
  for (const d of [userDataDir, projectDir]) if (d) rmSync(d, { recursive: true, force: true })
})

const rows = (): ReturnType<Page['locator']> => window.locator('.chat-tree-row')
const selected = (): Promise<string> =>
  window.locator('.chat-tree-row.selected').first().innerText()

test('↓ and ↑ open the next and previous session, in the order shown', async () => {
  const titles = await rows().allInnerTexts()
  await rows().first().click()
  await expect.poll(selected).toContain(titles[0].split('\n')[0])
  await window.keyboard.press('ArrowDown')
  await expect.poll(selected).toContain(titles[1].split('\n')[0])
  await window.keyboard.press('ArrowDown')
  await expect.poll(selected).toContain(titles[2].split('\n')[0])
  await window.keyboard.press('ArrowUp')
  await expect.poll(selected).toContain(titles[1].split('\n')[0])
  // The sidebar kept the keyboard throughout.
  expect(await window.evaluate(() => !!document.activeElement?.closest('.sidebar'))).toBe(true)
})

test('typing in the message box is left alone', async () => {
  const before = await selected()
  const input = window.locator('textarea.easy-input:visible').first()
  await input.click()
  await input.fill('line one')
  await window.keyboard.press('ArrowUp')
  await window.keyboard.press('ArrowDown')
  expect(await selected()).toBe(before)
})
