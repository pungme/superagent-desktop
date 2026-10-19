import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Thinking sits in a short box that follows the newest line while it is
 * written; a long stretch of it can be shown in full, and that choice sticks
 * for the next one. The agent is stood in for.
 */
test('long thinking can be shown in full', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-thought-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-thought-proj-'))
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
    await input.fill('why is the header broken?')
    await input.press('Enter')
    await expect.poll(async () => (await sent()).length).toBe(1)

    const lines = Array.from(
      { length: 24 },
      (_, i) => `Step ${i + 1}: checking how the nav wraps at this width.`
    )
    await send({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'thinking' } }
    })
    for (const l of lines)
      await send({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'thinking_delta', thinking: l + '\n' }
        }
      })
    const box = page.locator('.easy-thought:visible').last()
    await expect(box).toContainText('Step 24')
    // Capped, and showing the newest line while it is written.
    await expect
      .poll(() => box.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2))
      .toBe(true)
    expect((await box.boundingBox())!.height).toBeLessThan(160)
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-thought-1.png' })

    await send({ type: 'stream_event', event: { type: 'content_block_stop' } })
    await send({
      type: 'stream_event',
      event: { type: 'content_block_start', content_block: { type: 'text' } }
    })
    await send({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'The nav wraps.' } }
    })
    await send({ type: 'stream_event', event: { type: 'content_block_stop' } })
    await send({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: 'The nav wraps.' }] }
    })
    await send({ type: 'result', subtype: 'success', is_error: false, duration_api_ms: 900 })

    const more = page.locator('.easy-thought-more:visible').last()
    await expect(more).toHaveText('Show all')
    await more.click()
    await expect(more).toHaveText('Show less')
    // All of it, with the reply moved down below it rather than overlapping.
    const [thought, reply] = await Promise.all([
      box.boundingBox(),
      page.locator('.easy-msg.easy-assistant:visible').last().boundingBox()
    ])
    expect(thought!.height).toBeGreaterThan(300)
    expect(reply!.y).toBeGreaterThanOrEqual(thought!.y + thought!.height)
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-thought-2.png' })
    // The choice sticks for the next one.
    expect(await page.evaluate(() => localStorage.getItem('cove.thoughtFull'))).toBe('1')
    await more.click()
    await expect(more).toHaveText('Show all')
  } finally {
    await app.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
