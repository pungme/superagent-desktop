import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Auto mode: when a turn ends, the agent is asked whether anything is left, until it
 * says AUTO_DONE; it never talks over a question or a person. The agent is stood in
 * for; what the window sends it is recorded.
 */
test('Auto asks again after a turn, stops at AUTO_DONE and at a question', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-auto-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-auto-proj-'))
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
      ipcMain.on('agent:send', (_e, ...args: unknown[]) => g.sent.push(JSON.stringify(args)))
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
    const reply = async (text: string, id: string): Promise<void> => {
      await app.evaluate(
        ({ BrowserWindow }, p) => {
          const g = globalThis as unknown as { fake: string[] }
          const ch = `agent:event:${g.fake[g.fake.length - 1]}`
          const w = BrowserWindow.getAllWindows()[0].webContents
          w.send(ch, {
            type: 'assistant',
            message: { id: p.id, content: [{ type: 'text', text: p.text }] }
          })
          w.send(ch, { type: 'result', subtype: 'success', usage: {} })
        },
        { text, id }
      )
    }
    const autoSends = async (): Promise<number> =>
      (await sent()).filter((s) => s.includes('Auto mode: is there anything else left')).length

    // Auto is off by default and switches on from the chat's controls.
    const auto = page.locator('.easy-auto-btn:visible')
    await expect(auto.locator('.easy-control-val')).toHaveText('Off')
    await auto.click()
    await expect(auto.locator('.easy-control-val')).toHaveText('On')

    const input = page.locator('textarea.easy-input:visible')
    await input.fill('fix the header')
    await input.press('Enter')
    await expect.poll(async () => (await sent()).length).toBeGreaterThan(0)

    // A turn ends with work still to do: it is asked, as a chip, not a bubble.
    await reply('I fixed the header. Next I will check the footer.', 'm1')
    await expect.poll(autoSends, { timeout: 10_000 }).toBe(1)
    await expect(page.locator('.easy-loop-chip', { hasText: 'Auto: asked whether' })).toHaveCount(1)
    await expect(auto.locator('.easy-control-val')).toHaveText('On · 1/6')

    // It says it is done: nothing more is sent, and the sidebar does not show the sentinel.
    await reply('AUTO_DONE', 'm2')
    await page.waitForTimeout(2500)
    expect(await autoSends()).toBe(1)

    // The person writes: the count starts again, and a question is left alone.
    await input.fill('and the menu')
    await input.press('Enter')
    await expect.poll(async () => (await sent()).length).toBeGreaterThan(2)
    await reply('Should the menu open on hover or on click?', 'm3')
    await page.waitForTimeout(2500)
    expect(await autoSends()).toBe(1)
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-auto.png' })

    // Off again: stays off after a reload.
    await auto.click()
    await expect(auto.locator('.easy-control-val')).toHaveText('Off')
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
