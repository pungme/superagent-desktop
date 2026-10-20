import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * macOS says no to the microphone: the chat says so, offers System Settings,
 * and — the part that was missing — lets the line be taken down.
 */
test('a refused microphone shows a line with a way to Settings and a way to dismiss it', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-mic-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-mic-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const window = await app.firstWindow()
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      await window.cove.chatCreate(wsId)
    })
    await window.click('.sidebar-item:has-text("e2e-project")')
    // The Mac has the microphone off for this app.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('mic:access')
      ipcMain.handle('mic:access', () => 'denied')
      ipcMain.removeHandler('mic:open-settings')
      ipcMain.handle('mic:open-settings', () => {
        ;(globalThis as { openedSettings?: boolean }).openedSettings = true
      })
    })
    const mic = window.locator('.easy-mic:visible')
    await mic.dispatchEvent('pointerdown')
    await mic.dispatchEvent('pointerup')
    const line = window.locator('.easy-dictation-error')
    await expect(line).toContainText('not allowed to use the microphone')
    await line.getByRole('button', { name: 'Open System Settings' }).click()
    expect(
      await app.evaluate(() => (globalThis as { openedSettings?: boolean }).openedSettings)
    ).toBe(true)
    await line.getByRole('button', { name: 'Dismiss' }).click()
    await expect(line).toHaveCount(0)
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
