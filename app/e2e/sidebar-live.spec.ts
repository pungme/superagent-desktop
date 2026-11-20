import { test, expect, _electron as electron } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * While a session works, its row says what it is doing in words: the step's own
 * description, or what the agent said it is about to do. Never the raw command
 * ("./scripts/build-app.sh 2>&1 | tail -1"). The agent is stood in for.
 */
test('the live line under a working session is plain words, not the command', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-live-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-live-proj-'))
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
    const chatId = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const id = await window.cove.chatCreate(wsId)
      await window.cove.chatUpdate(id, { title: 'Make the repo private' })
      return id
    })
    execFileSync('sqlite3', [
      join(data, 'cove.db'),
      `UPDATE chats SET pinned = 1, pinnedAt = ${Date.now()} WHERE id = '${chatId}'`
    ])
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
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const row = page.locator('.sidebar-pinned-shortcuts .activity-row').first()
    await expect(row).toBeVisible({ timeout: 15_000 })
    await row.click()
    const input = page.locator('textarea.easy-input:visible')
    await input.fill('make the supercut repo private')
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

    // A command with its own description: the row says that.
    await send({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Bash',
            input: {
              command: './scripts/build-app.sh 2>&1 | tail -1',
              description: 'Build the app bundle'
            }
          }
        ]
      }
    })
    const live = row.locator('.activity-now')
    await expect(live).toHaveText('Build the app bundle', { timeout: 10_000 })
    await expect(live).not.toContainText('./scripts')

    // Then the agent says what it is about to do, and runs a command with no description.
    await send({
      type: 'assistant',
      message: {
        id: 'm2',
        content: [{ type: 'text', text: 'The build is green. Merging to main:' }]
      }
    })
    await send({
      type: 'assistant',
      message: {
        id: 'm3',
        content: [
          {
            type: 'tool_use',
            id: 't2',
            name: 'Bash',
            input: { command: 'git push origin HEAD:main' }
          }
        ]
      }
    })
    await expect(live).toHaveText('Merging to main', { timeout: 10_000 })
    if (process.env.SHOT) await page.screenshot({ path: '/tmp/sa-live.png' })
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
