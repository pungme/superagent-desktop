import { test, expect, _electron as electron } from '@playwright/test'
import { join } from 'path'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'

/** Right-click in the sidebar opens the app's own menu (not macOS's); a pick runs the item's action. */
test('the sidebar right-click is our own menu: Escape, a pick and a click away all work', async () => {
  test.setTimeout(90_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-ctx-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-ctx-proj-'))
  writeFileSync(join(proj, 'README.md'), '# ctx\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const chatId = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      // Two chats: the tree lists a project's conversations once it has more than one.
      const other = await window.cove.chatCreate(ws.id)
      await window.cove.chatUpdate(other, { title: 'Other' })
      const id = await window.cove.chatCreate(ws.id)
      await window.cove.chatUpdate(id, { title: 'Menu me' })
      return id
    })
    await page.reload()
    await page.waitForSelector('.chat-tree-row', { timeout: 20_000 })
    const row = page.locator('.chat-tree-row', { hasText: 'Menu me' }).first()
    await expect(row).toBeVisible({ timeout: 15_000 })

    await row.click({ button: 'right' })
    const menu = page.getByTestId('ctx-menu')
    await expect(menu).toBeVisible()
    await expect(menu).toContainText('Pin chat')
    await expect(menu).toContainText('Delete chat')
    // It opens inside the window.
    const box = (await menu.boundingBox())!
    expect(box.x).toBeGreaterThanOrEqual(0)
    expect(box.y).toBeGreaterThanOrEqual(0)

    // Escape closes it, nothing happens.
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)

    // A pick runs main's own action for it: Pin chat.
    await row.click({ button: 'right' })
    await page.getByTestId('ctx-menu').getByRole('menuitem', { name: 'Pin chat' }).click()
    await expect(page.getByTestId('ctx-menu')).toHaveCount(0)
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const tree = await window.cove.storeTree()
          const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
          return (await window.cove.chatList(ws.id)).find((c) => c.id === id)?.pinned
        }, chatId)
      )
      .toBeTruthy()

    // It now offers Unpin; a click elsewhere closes it.
    await row.click({ button: 'right' })
    await expect(page.getByTestId('ctx-menu')).toContainText('Unpin chat')
    await page.locator('main').click({ position: { x: 300, y: 300 } })
    await expect(page.getByTestId('ctx-menu')).toHaveCount(0)

    // The project's menu starts a Conductor in the app's own modal, then opens the Conductor view.
    await page.locator('.sidebar-item:has-text("e2e-project")').first().click({ button: 'right' })
    await page.getByTestId('ctx-menu').getByRole('menuitem', { name: 'Start Conductor…' }).click()
    const modal = page.getByTestId('start-conductor')
    await expect(modal).toBeVisible()
    await expect(modal.getByTestId('start-adopt')).toContainText('Connect the 2 existing chats')
    await modal.getByTestId('start-clean').click()
    await expect(modal).toHaveCount(0)
    await expect(page.getByTestId('conductor-main-here')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('sidebar-conductor-row')).toContainText('e2e-project')
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
