import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A chat from the Chats list belongs to no project. Pinned, its row had the
 * project's name as its headline, which is nothing: the row was blank. It
 * goes by its own name, and opens where Chats does.
 */

let app: ElectronApplication
let window: Page
let data: string
let proj: string

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-pinhome-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-pinhome-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  window = await app.firstWindow()
  await window.waitForLoadState('domcontentloaded')
  await window.evaluate(() => {
    localStorage.setItem('cove.onboarded', '1')
    localStorage.setItem('cove.connectionsOffered', '1')
  })
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
})
test.afterAll(async () => {
  await app?.close()
  for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
})

test('a pinned chat from Chats shows its own name, and opens', async () => {
  const ids = await window.evaluate(async () => {
    const home = (await window.cove.desktopChatHome())!.workspaceId
    const named = await window.cove.chatCreate(home)
    await window.cove.chatUpdate(named, { title: 'Draw the floor plan' })
    const unnamed = await window.cove.chatCreate(home)
    return { named, unnamed }
  })
  // Pinning is the chat menu's, which is native; this is what it writes.
  for (const id of [ids.named, ids.unnamed])
    execFileSync('sqlite3', [
      join(data, 'cove.db'),
      `UPDATE chats SET pinned = 1, pinnedAt = ${Date.now()} WHERE id = '${id}'`
    ])
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })

  const rows = window.locator('.sidebar-pinned-shortcuts .activity-row')
  await expect(rows).toHaveCount(2, { timeout: 15_000 })
  const titles = rows.locator('.activity-title')
  await expect(titles.filter({ hasText: 'Draw the floor plan' })).toHaveCount(1)
  // One with no name yet says so, rather than nothing.
  await expect(titles.filter({ hasText: 'New chat' })).toHaveCount(1)
  for (const t of await titles.allTextContents()) expect(t.trim()).not.toBe('')

  const row = rows.filter({ hasText: 'Draw the floor plan' })
  await row.click()
  await expect(row).toHaveClass(/\bon\b/)
  await expect(window.locator('textarea.easy-input:visible')).toBeVisible({ timeout: 15_000 })
  if (process.env.SHOT) await window.screenshot({ path: '/tmp/sa-pinned-home.png' })

  // And renamed where it is.
  await row.dblclick()
  const rename = rows.locator('input.sidebar-item-rename')
  // Typed, not filled: the row is marked not draggable while its name is
  // edited, which Playwright reads as the field being disabled. It is not.
  await expect(rename).toBeFocused()
  await window.keyboard.press('Meta+a')
  await window.keyboard.type('Floor plan, second pass')
  await window.keyboard.press('Enter')
  await expect(titles.filter({ hasText: 'Floor plan, second pass' })).toHaveCount(1, {
    timeout: 10_000
  })
})
