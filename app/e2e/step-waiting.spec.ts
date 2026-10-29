import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Inside a long step (a deploy, a wait loop) the agent reads nothing until the
 * step returns. The chat says which step it is in and for how long, and when
 * you write to it meanwhile, that your messages wait, with a way to stop the
 * step and have them answered. The agent is stood in for.
 */
test('a long step says what it is, and messages sent during it say they wait', async () => {
  test.setTimeout(90_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-step-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-step-proj-'))
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
      const g = globalThis as unknown as { fake: string[]; sent: string[]; stopped: number }
      g.fake = []
      g.sent = []
      g.stopped = 0
      ipcMain.removeHandler('agent:start')
      ipcMain.handle('agent:start', () => {
        g.fake.push(`fake-${g.fake.length + 1}`)
        return g.fake[g.fake.length - 1]
      })
      ipcMain.removeHandler('agent:suggestTitle')
      ipcMain.handle('agent:suggestTitle', () => null)
      ipcMain.removeAllListeners('agent:send')
      ipcMain.on('agent:send', (_e, _id: string, text: string) => g.sent.push(text))
      ipcMain.removeHandler('agent:hard-interrupt')
      ipcMain.handle('agent:hard-interrupt', () => {
        g.stopped += 1
        return true
      })
    })
    await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      await window.cove.chatCreate(wsId)
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')

    const g = (): Promise<{ sent: string[]; stopped: number }> =>
      app.evaluate(() => globalThis as unknown as { sent: string[]; stopped: number })
    const emit = (event: unknown): Promise<void> =>
      app.evaluate(({ BrowserWindow }, e) => {
        const f = (globalThis as unknown as { fake: string[] }).fake
        BrowserWindow.getAllWindows()[0].webContents.send(`agent:event:${f[f.length - 1]}`, e)
      }, event)

    const input = page.locator('textarea.easy-input:visible')
    const sendBtn = page.getByRole('button', { name: 'Send message' }).last()
    await input.fill('deploy it')
    await sendBtn.click()
    await expect.poll(async () => (await g()).sent.length).toBe(1)

    // The agent starts a long step and goes quiet inside it.
    await emit({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          {
            type: 'tool_use',
            id: 'tu1',
            name: 'Bash',
            input: { command: 'gh run watch 123 --exit-status' }
          }
        ]
      }
    })
    const now = page.locator('.easy-step-now')
    await expect(now).toContainText('gh run watch 123', { timeout: 10_000 })
    await expect(now).toContainText(/\d+s/)

    // Written to it meanwhile: it says they wait, and offers to stop.
    await input.fill('status?')
    await sendBtn.click()
    const waiting = page.locator('.easy-step-waiting')
    await expect(waiting).toContainText('Your message waits until this step finishes')
    await input.fill('answer me')
    await sendBtn.click()
    await expect(waiting).toContainText('Your 2 messages wait')
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-step-waiting.png' })

    await waiting.getByRole('button', { name: 'Stop and answer' }).click()
    await expect.poll(async () => (await g()).stopped).toBe(1)
    await expect(page.locator('.easy-step-waiting')).toHaveCount(0)
    await expect(
      page.locator('.easy-msg', { hasText: 'Interrupted — picking up your message' })
    ).toHaveCount(1)
  } finally {
    await app.close()
    rmSync(data, { recursive: true, force: true })
    rmSync(proj, { recursive: true, force: true })
  }
})
