import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every Claude account out of allowance, and Codex signed in with some left: the chat
 * moves to Codex by itself and the message that hit the limit is sent again. The
 * agents are stood in for; what the window starts and sends is recorded.
 */
test('out of allowance on every account: the chat carries on with the next agent', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-fallback-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-fallback-proj-'))
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
      const g = globalThis as unknown as { fake: string[]; sent: string[]; starts: string[] }
      g.fake = []
      g.sent = []
      g.starts = []
      ipcMain.removeHandler('agent:start')
      ipcMain.handle('agent:start', (_e, opts: { provider?: string }) => {
        g.starts.push(opts?.provider ?? 'claude')
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

    const input = page.locator('textarea.easy-input:visible')
    await input.fill('fix the header')
    await input.press('Enter')
    const sentCount = (): Promise<number> =>
      app.evaluate(
        () =>
          (globalThis as unknown as { sent: string[] }).sent.filter((s) =>
            s.includes('fix the header')
          ).length
      )
    await expect.poll(sentCount).toBe(1)

    // The notice main sends when the last Claude account is out and Codex can take over.
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { fake: string[] }
      void g
      BrowserWindow.getAllWindows()[0].webContents.send('accounts:limit', {
        chatId: '*',
        provider: 'claude',
        account: { id: 'claude:login', name: 'Your Claude login' },
        until: Date.now() + 3_600_000,
        alternatives: [],
        switchedTo: null,
        mode: 'auto',
        agents: ['codex', 'antigravity'],
        switchedToAgent: 'codex'
      })
    })
    // chatId '*' is not this chat: nothing happens.
    await page.waitForTimeout(800)
    expect(await sentCount()).toBe(1)

    const chatId = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      return (await window.cove.chatList(wsId))[0].id
    })
    await app.evaluate(({ BrowserWindow }, id) => {
      BrowserWindow.getAllWindows()[0].webContents.send('accounts:limit', {
        chatId: id,
        provider: 'claude',
        account: { id: 'claude:login', name: 'Your Claude login' },
        until: Date.now() + 3_600_000,
        alternatives: [],
        switchedTo: null,
        mode: 'auto',
        agents: ['codex', 'antigravity'],
        switchedToAgent: 'codex'
      })
    }, chatId)
    await expect(page.locator('.easy-msg', { hasText: 'continuing on Codex' }).first()).toBeVisible(
      { timeout: 10_000 }
    )
    // Codex is started, and the message that hit the limit goes to it.
    await expect
      .poll(() => app.evaluate(() => (globalThis as unknown as { starts: string[] }).starts))
      .toContain('codex')
    await expect.poll(sentCount, { timeout: 10_000 }).toBe(2)
    await expect(page.locator('.easy-limit')).toHaveCount(0)
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-fallback.png' })
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
