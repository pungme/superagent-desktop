import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** A picture opened from a message closes on Esc, as it does on a click. */
test('Esc closes an enlarged picture', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-lb-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-lb-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const window = await app.firstWindow()
    await window.waitForLoadState('domcontentloaded')
    await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.evaluate(async (png) => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const chatId = await window.cove.chatCreate(wsId)
      window.cove.chatSave(
        chatId,
        JSON.stringify([
          { kind: 'msg', msg: { id: 'u1', role: 'user', text: 'look at this', images: [png] } }
        ])
      )
    }, PNG)
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.click('.sidebar-item:has-text("e2e-project")')

    const thumb = window.locator('.easy-msg-images img:visible').first()
    await expect(thumb).toBeVisible({ timeout: 15_000 })
    await thumb.click()
    await expect(window.locator('.easy-lightbox')).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(window.locator('.easy-lightbox')).toHaveCount(0)
    // And a click still does.
    await thumb.click()
    await window.locator('.easy-lightbox').click()
    await expect(window.locator('.easy-lightbox')).toHaveCount(0)
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
