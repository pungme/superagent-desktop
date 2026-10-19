import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A chat that slept wakes with your message, and the CLI first handles a notice
 * that queued up meanwhile (a background task stopped): a turn of its own that
 * never reaches the model and says nothing. That is not your message's answer,
 * and sending your message again because of it made the agent say "That
 * message came through twice". An answer that really came back empty is still
 * asked again, once. The agent is stood in for.
 */
test('a notice’s silent turn does not send your message twice', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-twice-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-twice-proj-'))
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
      const g = globalThis as unknown as { fake: string[]; sent: string[] }
      g.fake = []
      g.sent = []
      ipcMain.removeHandler('agent:start')
      ipcMain.handle('agent:start', () => {
        g.fake.push(`fake-${g.fake.length + 1}`)
        return g.fake[g.fake.length - 1]
      })
      ipcMain.removeHandler('agent:suggestTitle')
      ipcMain.handle('agent:suggestTitle', () => null)
      ipcMain.removeAllListeners('agent:send')
      ipcMain.on('agent:send', (_e, _id: string, text: string) => g.sent.push(text))
    })
    await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      await window.cove.chatCreate(wsId)
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')

    const sent = (): Promise<string[]> =>
      app.evaluate(() => (globalThis as unknown as { sent: string[] }).sent)
    const send = (event: unknown): Promise<void> =>
      app.evaluate(({ BrowserWindow }, e) => {
        const g = globalThis as unknown as { fake: string[] }
        BrowserWindow.getAllWindows()[0].webContents.send(
          `agent:event:${g.fake[g.fake.length - 1]}`,
          e
        )
      }, event)

    const input = page.locator('textarea.easy-input:visible')
    await input.fill('do we merge it as well?')
    await input.press('Enter')
    await expect.poll(async () => (await sent()).length).toBe(1)

    // The notice's turn: done, nothing said, the model never asked.
    await send({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 0 })
    await page.waitForTimeout(500)
    expect(await sent()).toHaveLength(1)
    await expect(page.locator('text=ended the turn without a response')).toHaveCount(0)

    // Then the answer to the message itself.
    await send({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'text' } }
    })
    await send({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'Not in this branch.' }
      }
    })
    await send({
      type: 'stream_event',
      event: { type: 'content_block_stop' }
    })
    await send({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'Not in this branch.' }] }
    })
    await send({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 1400 })
    await expect(page.locator('.easy-msg.easy-assistant:visible').last()).toContainText(
      'Not in this branch.'
    )
    expect(await sent()).toHaveLength(1)

    // A real answer that came back empty (the model was asked) is asked again, once.
    await input.fill('and the other one?')
    await input.press('Enter')
    await expect.poll(async () => (await sent()).length).toBe(2)
    await send({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 2600 })
    await expect.poll(async () => (await sent()).length).toBe(3)
    expect((await sent())[2]).toContain('and the other one?')
  } finally {
    await app.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
