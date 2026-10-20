import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A pane opened while its device is still booting: the input daemon says no at
 * first and yes a little later. The pane must notice and switch to live touch
 * (a finger down the moment the pointer goes down), not stay on tap-on-release.
 */
test('touch goes live once the device answers, not only if it answered at mount', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-livetouch-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-livetouch-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const window = await app.firstWindow()
    const UDID = 'FAKE-0000-1111-2222-444444444444'
    await app.evaluate(({ ipcMain, BrowserWindow }, udid) => {
      const g = globalThis as { inputs?: unknown[]; readyAsks?: number }
      g.inputs = []
      g.readyAsks = 0
      const swap = (ch: string, fn: (...a: unknown[]) => unknown): void => {
        ipcMain.removeHandler(ch)
        ipcMain.handle(ch, (_e, ...a: unknown[]) => fn(...a))
      }
      swap('sim:list', () => [{ udid, name: 'iPhone 17', state: 'Booted', runtime: 'iOS 27' }])
      swap('sim:view-attach', () => ({ ok: false, error: 'no booted simulator with that udid' }))
      swap('sim:view-detach', () => undefined)
      swap('sim:screens', () => [])
      swap('sim:orientation', () => 'portrait')
      swap('sim:has-input', () => true)
      // Not ready for the first two asks — a device still coming up — then ready.
      swap('sim:hid-ready', () => ++g.readyAsks! > 2)
      swap('sim:input', (_udid: unknown, action: unknown) => {
        g.inputs!.push(action)
        return { ok: true }
      })
      ipcMain.removeAllListeners('sim:stream-start')
      ipcMain.on('sim:stream-start', (e) => {
        BrowserWindow.fromWebContents(e.sender)!.webContents.send(`sim:frame:${udid}`, {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
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
    const screen = window.locator('img.sim-screen')
    await expect(screen).toBeVisible({ timeout: 20_000 })
    const kinds = (): Promise<string[]> =>
      app.evaluate(() =>
        ((globalThis as { inputs?: { type: string; phase?: string }[] }).inputs ?? []).map((a) =>
          a.phase ? `${a.type}:${a.phase}` : a.type
        )
      )
    // Once the device has answered yes (asked again, a second or two later),
    // a pointer going down is a finger going down.
    await expect
      .poll(() => app.evaluate(() => (globalThis as { readyAsks?: number }).readyAsks ?? 0), {
        timeout: 15_000
      })
      .toBeGreaterThan(2)
    await window.waitForTimeout(300)
    const box = (await screen.boundingBox())!
    await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await window.mouse.down()
    await expect.poll(kinds).toContain('touch:start')
    await window.mouse.up()
    await expect.poll(kinds).toContain('touch:end')
    expect(await kinds()).not.toContain('tap')
  } finally {
    await app.close()
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
