import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Two things about the model a chat runs on:
 *  - when a lower model has taken over from the one picked (its allowance ran
 *    out), the pill says what is running and what was asked for;
 *  - moving a chat to another agent and back brings the model picked for the
 *    first one back, instead of leaving it on Default.
 * The agent is stood in for; it reports the model it started on.
 */
test('the pill shows the model that runs; switching agents keeps each one’s pick', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-model-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-model-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('agent:start')
      ipcMain.handle('agent:start', () => 'fake-1')
      ipcMain.removeHandler('agent:suggestTitle')
      ipcMain.handle('agent:suggestTitle', () => null)
      ipcMain.removeAllListeners('agent:send')
    })
    const chatId = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const id = await window.cove.chatCreate(wsId)
      await window.cove.chatSetModel(id, 'claude-fable-5-2')
      return id
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    const input = page.locator('textarea.easy-input:visible')
    await input.fill('hello')
    await input.press('Enter')

    const init = (model: string): Promise<void> =>
      app.evaluate(({ BrowserWindow }, m) => {
        BrowserWindow.getAllWindows()[0].webContents.send('agent:event:fake-1', {
          type: 'system',
          subtype: 'init',
          model: m,
          session_id: 's1'
        })
      }, model)
    const shifted = page.getByTestId('model-shifted')

    // The pick runs: nothing to say.
    await init('claude-fable-5-2')
    await expect(page.locator('.easy-control-val', { hasText: /Fable/ }).first()).toBeVisible({
      timeout: 10_000
    })
    await expect(shifted).toHaveCount(0)

    // Fable's allowance is out and Opus carries the chat: the pill says so.
    await init('claude-opus-5-5')
    await expect(shifted).toBeVisible({ timeout: 10_000 })
    await expect(shifted).toContainText('Opus 5.5')
    await expect(shifted).toContainText('not Fable 5.2')
    await expect(shifted).toHaveAttribute('title', /used up its allowance/)

    // Back on Fable once it can: the pill is quiet again.
    await init('claude-fable-5-2')
    await expect(shifted).toHaveCount(0, { timeout: 10_000 })

    // The same family under another spelling is not a shift.
    await init('claude-fable-5-2[1m]')
    await expect(shifted).toHaveCount(0)

    // Another agent and back: each keeps its own pick.
    const picks = await page.evaluate(async (id) => {
      const out: (string | null)[] = []
      out.push(await window.cove.chatGetModel(id)) // fable
      await window.cove.chatUpdate(id, { provider: 'codex', claudeSessionId: null })
      out.push(await window.cove.chatGetModel(id)) // a newcomer: its own default
      await window.cove.chatSetModel(id, 'gpt-5.5')
      await window.cove.chatUpdate(id, { provider: 'claude', claudeSessionId: null })
      out.push(await window.cove.chatGetModel(id)) // claude's pick is back
      await window.cove.chatUpdate(id, { provider: 'codex', claudeSessionId: null })
      out.push(await window.cove.chatGetModel(id)) // and codex's
      return out
    }, chatId)
    expect(picks).toEqual(['claude-fable-5-2', null, 'claude-fable-5-2', 'gpt-5.5'])
  } finally {
    await app.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
