import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A reply as it is written: let out at an even pace, each new word coming in,
 * a soft dot where it has got to; and, once it is whole, plain text again with
 * nothing of the animation left in it. The agent is stood in for.
 */
test('a reply arrives a word at a time, and settles as plain text', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-arrive-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-arrive-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate((theme) => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      if (theme) localStorage.setItem('cove.theme', theme)
    }, process.env.THEME ?? '')
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { fake: string[] }
      g.fake = []
      ipcMain.removeHandler('agent:start')
      ipcMain.handle('agent:start', () => {
        g.fake.push(`fake-${g.fake.length + 1}`)
        return g.fake[g.fake.length - 1]
      })
      ipcMain.removeHandler('agent:suggestTitle')
      ipcMain.handle('agent:suggestTitle', () => null)
      ipcMain.removeAllListeners('agent:send')
      ipcMain.on('agent:send', () => undefined)
    })
    await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      await window.cove.chatCreate(wsId)
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    const input = page.locator('textarea.easy-input:visible')
    await input.fill('tell me about the header')
    await input.press('Enter')
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { fake: string[] }).fake.length))
      .toBeGreaterThan(0)

    const send = (event: unknown): Promise<void> =>
      app.evaluate(({ BrowserWindow }, e) => {
        const g = globalThis as unknown as { fake: string[] }
        BrowserWindow.getAllWindows()[0].webContents.send(
          `agent:event:${g.fake[g.fake.length - 1]}`,
          e
        )
      }, event)
    const stream = (ev: unknown): Promise<void> => send({ type: 'stream_event', event: ev })

    const reply =
      'The header was the problem. It **collapsed below 400 points** because the nav wrapped, ' +
      'so I gave the logo a fixed width and let the links shrink instead.\n\n' +
      '- The nav now collapses at 640, not 720\n- The buttons stack rather than shrink\n\n' +
      'Run `npm test` to see it: all green here.'
    await stream({ type: 'content_block_start', content_block: { type: 'text' } })
    // In bursts, as an agent sends it: a few words, a pause, a long run at once.
    const half = reply.indexOf('so I gave')
    await stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(0, 24) } })
    await page.waitForTimeout(120)
    await stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(24, half) } })

    const arriving = page.locator('.md-arriving')
    await expect(arriving).toBeVisible({ timeout: 10_000 })
    // Words are in spans of their own while it is being written…
    await expect.poll(() => arriving.locator('.sw').count()).toBeGreaterThan(3)
    // …and not all of a burst is on screen the instant it lands.
    const early = await arriving.locator('.sw').count()
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-arrive-1.png' })
    await stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: reply.slice(half) } })
    await page.waitForTimeout(90)
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-arrive-2.png' })
    await expect
      .poll(() => arriving.locator('.sw').count(), { timeout: 10_000 })
      .toBeGreaterThan(early + 10)
    // Code is not broken into words.
    await expect(arriving.locator('code .sw')).toHaveCount(0)

    // The turn ends: the last words still come in, then it is plain text.
    await stream({ type: 'content_block_stop' })
    await send({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: reply }] } })
    await send({ type: 'result', subtype: 'success', usage: {} })
    const bubble = page.locator('.easy-msg.easy-assistant:visible').last()
    await expect(bubble).toContainText('all green here.', { timeout: 10_000 })
    await expect(bubble).toContainText('collapsed below 400 points')
    await expect(page.locator('.md-arriving')).toHaveCount(0, { timeout: 10_000 })
    await expect(bubble.locator('.sw')).toHaveCount(0)
    await expect(bubble.locator('li')).toHaveCount(2)
    await expect(bubble.locator('code')).toHaveText('npm test')
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-arrive-3.png' })
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
