import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Under a session's title the sidebar says what it is at: the first words of the
 * agent's last reply, kept by main so a chat that is not open shows it too.
 */

let app: ElectronApplication
let window: Page
let data: string
let proj: string

test.beforeAll(async () => {
  data = mkdtempSync(join(tmpdir(), 'cove-now-data-'))
  proj = mkdtempSync(join(tmpdir(), 'cove-now-proj-'))
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

test('a pinned session shows what it is at, and drops it when it is cleared', async () => {
  const id = await window.evaluate(async () => {
    const home = (await window.cove.desktopChatHome())!.workspaceId
    const c = await window.cove.chatCreate(home)
    await window.cove.chatUpdate(c, { title: 'Fix the header' })
    return c
  })
  execFileSync('sqlite3', [
    join(data, 'cove.db'),
    `UPDATE chats SET pinned = 1, pinnedAt = ${Date.now()} WHERE id = '${id}'`
  ])
  await window.reload()
  await window.waitForSelector('.sidebar', { timeout: 20_000 })
  const row = window.locator('.sidebar-pinned-shortcuts .activity-row', {
    hasText: 'Fix the header'
  })
  await expect(row).toHaveCount(1, { timeout: 15_000 })
  // Nothing to say yet: no line, not a placeholder.
  await expect(row.locator('.activity-now')).toHaveCount(0)

  const changed = await window.evaluate(
    (chatId) =>
      window.cove.chatSetNow(chatId, 'Fixed. The nav wrapped under 400 px and pushed the logo off'),
    id
  )
  expect(changed).toBe(true)
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('cove:workspace-idle')))
  await expect(row.locator('.activity-now')).toHaveText(
    'Fixed. The nav wrapped under 400 px and pushed the logo off'
  )
  if (process.env.SHOT) await window.screenshot({ path: '/tmp/sa-now.png' })

  // Saying the same thing again changes nothing; clearing removes the line.
  expect(
    await window.evaluate(
      (chatId) =>
        window.cove.chatSetNow(
          chatId,
          'Fixed. The nav wrapped under 400 px and pushed the logo off'
        ),
      id
    )
  ).toBe(false)
  await window.evaluate((chatId) => window.cove.chatSetNow(chatId, ''), id)
  await window.evaluate(() => window.dispatchEvent(new CustomEvent('cove:workspace-idle')))
  await expect(row.locator('.activity-now')).toHaveCount(0)
})
