import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Two conversations in one project, each with its own simulator. The pane
 * shows each conversation its own device, never the other's — and an agent in
 * one booting its device does not swap the pane in the other.
 */
test("each conversation's pane shows its own simulator, never the other's", async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-simchat-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-simchat-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  const A = 'AAAAAAAA-0000-0000-0000-000000000001'
  const B = 'BBBBBBBB-0000-0000-0000-000000000002'
  try {
    const page = await app.firstWindow()
    await app.evaluate(
      ({ ipcMain, BrowserWindow }, ids) => {
        const swap = (ch: string, fn: (...a: unknown[]) => unknown): void => {
          ipcMain.removeHandler(ch)
          ipcMain.handle(ch, (_e, ...a: unknown[]) => fn(...a))
        }
        swap('sim:list', () => [
          { udid: ids.A, name: 'Phone of A', state: 'Booted', runtime: 'iOS 27' },
          { udid: ids.B, name: 'Phone of B', state: 'Booted', runtime: 'iOS 27' }
        ])
        swap('sim:view-attach', () => ({ ok: false, error: 'test: no embedding' }))
        swap('sim:view-detach', () => undefined)
        swap('sim:screens', () => [])
        swap('sim:orientation', () => 'portrait')
        swap('sim:hid-ready', () => true)
        swap('sim:has-input', () => true)
        ipcMain.removeAllListeners('sim:stream-start')
        ipcMain.on('sim:stream-start', (e, udid: string) => {
          BrowserWindow.fromWebContents(e.sender)!.webContents.send(`sim:frame:${udid}`, {
            url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
            width: 402,
            height: 874
          })
        })
        ipcMain.removeAllListeners('sim:stream-stop')
        ipcMain.on('sim:stream-stop', () => undefined)
      },
      { A, B }
    )
    await page.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const { ws, chatA, chatB } = await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const chatA = await window.cove.chatCreate(ws)
      await window.cove.chatUpdate(chatA, { title: 'Conversation A' })
      const chatB = await window.cove.chatCreate(ws)
      await window.cove.chatUpdate(chatB, { title: 'Conversation B' })
      return { ws, chatA, chatB }
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')
    const open = (chatId: string, udid: string): Promise<void> =>
      app.evaluate(
        ({ BrowserWindow }, p) => {
          BrowserWindow.getAllWindows()[0].webContents.send('app:open-simulator', p)
        },
        { workspaceId: ws, chatId, udid }
      )
    const name = page.locator('.sim-device-name:visible')
    // A's agent boots A's phone, with A on screen.
    await page.locator('.sidebar').getByText('Conversation A').first().click()
    await open(chatA, A)
    await expect(name).toHaveText('Phone of A', { timeout: 15_000 })
    // Over to B: not A's phone.
    await page.locator('.sidebar').getByText('Conversation B').first().click()
    await page.waitForTimeout(800)
    expect((await name.count()) === 0 || (await name.textContent()) !== 'Phone of A').toBe(true)
    // B's agent boots B's phone.
    await open(chatB, B)
    await expect(name).toHaveText('Phone of B', { timeout: 15_000 })
    // A's agent acts again while B is on screen: B's pane stays on B.
    await open(chatA, A)
    await page.waitForTimeout(800)
    await expect(name).toHaveText('Phone of B')
    // Main agrees on who has which.
    expect(await page.evaluate((c) => window.cove.simForChat(c), chatB)).toBe(B)
    expect(await page.evaluate((c) => window.cove.simForChat(c), chatA)).toBe(A)
    // Back to A: A's phone again.
    await page.locator('.sidebar').getByText('Conversation A').first().click()
    await expect(name).toHaveText('Phone of A', { timeout: 15_000 })
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
