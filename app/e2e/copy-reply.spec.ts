import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Copy on a reply says it has copied. It used to do its work with no sign at
 * all, which reads as a button that did nothing.
 */
test('Copy on a reply says "Copied" for a moment, then is Copy again', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-copy-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-copy-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    // Not the real clipboard: whoever is at the Mac is using that.
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { __copied: string[] }
      g.__copied = []
      ipcMain.removeAllListeners('clipboard:write')
      ipcMain.on('clipboard:write', (_e, text: string) => g.__copied.push(text))
    })
    const window = await app.firstWindow()
    await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const chatId = await window.cove.chatCreate(wsId)
      window.cove.chatSave(
        chatId,
        JSON.stringify([
          { kind: 'msg', msg: { id: 'u1', role: 'user', text: 'What is the plan?' } },
          {
            kind: 'msg',
            msg: { id: 'a1', role: 'assistant', text: 'The plan is **three steps**.' }
          },
          { kind: 'msg', msg: { id: 'a2', role: 'assistant', text: 'And a second reply.' } }
        ])
      )
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.click('.sidebar-item:has-text("e2e-project")')
    const reply = window.locator('.easy-assistant:visible', { hasText: 'three steps' })
    const copy = reply.locator('.easy-msg-copy')
    const other = window
      .locator('.easy-assistant:visible', { hasText: 'second reply' })
      .locator('.easy-msg-copy')
    await reply.hover()
    await expect(copy).toHaveText('Copy')
    await copy.click()
    await expect(copy).toHaveText('Copied')
    // The reply as written, not as drawn; and only this reply's button changed.
    expect(
      await app.evaluate(() => (globalThis as unknown as { __copied: string[] }).__copied)
    ).toEqual(['The plan is **three steps**.'])
    await expect(other).toHaveText('Copy')
    // Still readable once the pointer has gone elsewhere.
    await window.mouse.move(5, 5)
    await expect(copy).toHaveCSS('opacity', '1')
    await expect(copy).toHaveText('Copy', { timeout: 4_000 })
    await expect(copy).toHaveCSS('opacity', '0')
    // Pressed twice quickly, it is one "Copied", not a flicker back to Copy.
    await reply.hover()
    await copy.click()
    await copy.click()
    await expect(copy).toHaveText('Copied')
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
