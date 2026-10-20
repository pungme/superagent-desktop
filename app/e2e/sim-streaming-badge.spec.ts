import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A streamed simulator picture looks like the embedded one and feels worse.
 * When the screen could not be embedded, the pane must say it is streaming,
 * and why. No real device: the main process is made to refuse the embed and
 * hand over one frame.
 */
test('the pane labels a streamed simulator picture, with the reason', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-simbadge-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-simbadge-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const window = await app.firstWindow()
    const UDID = 'FAKE-0000-1111-2222-333333333333'
    // A booted device that cannot be embedded; the stream hands over one frame.
    await app.evaluate(({ ipcMain, BrowserWindow }, udid) => {
      const swap = (ch: string, fn: (...a: unknown[]) => unknown): void => {
        ipcMain.removeHandler(ch)
        ipcMain.handle(ch, (_e, ...a: unknown[]) => fn(...a))
      }
      swap('sim:list', () => [{ udid, name: 'iPhone 17', state: 'Booted', runtime: 'iOS 27' }])
      swap('sim:view-attach', () => ({ ok: false, error: 'no booted simulator with that udid' }))
      swap('sim:view-detach', () => undefined)
      swap('sim:screens', () => [])
      swap('sim:orientation', () => 'portrait')
      swap('sim:hid-ready', () => true)
      swap('sim:has-input', () => true)
      ipcMain.removeAllListeners('sim:stream-start')
      ipcMain.on('sim:stream-start', (e) => {
        const png =
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
        BrowserWindow.fromWebContents(e.sender)!.webContents.send(`sim:frame:${udid}`, {
          url: png,
          width: 402,
          height: 874
        })
      })
      ipcMain.removeAllListeners('sim:stream-stop')
      ipcMain.on('sim:stream-stop', () => undefined)
    }, UDID)
    await window.evaluate(async (udid) => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!
      localStorage.setItem(`cove.simDevice:${ws.id}`, udid)
      localStorage.setItem(`simOpen:${ws.id}`, '1')
    }, UDID)
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.locator('.sidebar-item', { hasText: 'e2e-project' }).first().click()
    const badge = window.locator('.sim-streaming')
    await expect(badge).toBeVisible({ timeout: 20_000 })
    await expect(badge).toContainText('Streaming')
    await expect(badge).toHaveAttribute('title', /no booted simulator with that udid/)
    await window.screenshot({ path: '/tmp/sa-sim-streaming.png' })
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
