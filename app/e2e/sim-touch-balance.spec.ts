import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Every finger put down is lifted exactly once, to the device it went to —
 * whatever changes between press and release. A dropped touch:end leaves a
 * finger stuck on the device, and from then on every tap is read as a second
 * finger: the "first touch fine, second and third bad" report.
 */
test('a touch:start is always balanced by one touch:end, even on cancel or device switch', async () => {
  test.setTimeout(90_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-touchbal-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-touchbal-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  const A = 'AAAAAAAA-0000-0000-0000-0000000000A1'
  const B = 'BBBBBBBB-0000-0000-0000-0000000000B2'
  try {
    const page = await app.firstWindow()
    await app.evaluate(
      ({ ipcMain, BrowserWindow }, ids) => {
        const g = globalThis as { inputs?: { udid: string; type: string; phase?: string }[] }
        g.inputs = []
        const swap = (ch: string, fn: (...a: unknown[]) => unknown): void => {
          ipcMain.removeHandler(ch)
          ipcMain.handle(ch, (_e, ...a: unknown[]) => fn(...a))
        }
        swap('sim:list', () => [
          { udid: ids.A, name: 'Phone A', state: 'Booted', runtime: 'iOS 27' },
          { udid: ids.B, name: 'Phone B', state: 'Booted', runtime: 'iOS 27' }
        ])
        swap('sim:view-attach', () => ({
          ok: true,
          width: 390,
          height: 844,
          screens: 1,
          device: 'Phone'
        }))
        swap('sim:view-detach', () => undefined)
        swap('sim:view-bounds', () => undefined)
        swap('sim:view-visible', () => undefined)
        swap('sim:screens', () => [{ width: 390, height: 844, lit: true }])
        swap('sim:orientation', () => 'portrait')
        swap('sim:hid-ready', () => true)
        swap('sim:has-input', () => true)
        // Record every input. This is the fallback path: with no input port the
        // renderer's simInputDirect returns null and falls here.
        swap('sim:input', (udid: string, action: { type: string; phase?: string }) => {
          g.inputs!.push({ udid, ...action })
          return { ok: true }
        })
        // Never hand the renderer a direct port, so all input is observable here.
        ipcMain.removeAllListeners('sim:input-port')
        BrowserWindow.getAllWindows() // noop ref
      },
      { A, B }
    )
    await page.evaluate(
      (ids) => {
        localStorage.setItem('cove.onboarded', '1')
        localStorage.setItem('cove.connectionsOffered', '1')
        ;(window as unknown as { __ids: typeof ids }).__ids = ids
      },
      { A, B }
    )
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    const ws = await page.evaluate(
      async (ids) => {
        const tree = await window.cove.storeTree()
        const ws = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
        const chat = await window.cove.chatCreate(ws)
        localStorage.setItem(`cove.simDevice:${ws}:${chat}`, ids.A)
        localStorage.setItem(`cove.simDevice:${ws}`, ids.A)
        localStorage.setItem(`simOpen:${chat}`, '1')
        return ws
      },
      { A, B }
    )
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.locator('.sidebar-item', { hasText: 'e2e-project' }).first().click()
    const box = page.locator('.sim-screen.sim-native')
    await expect(box).toBeVisible({ timeout: 20_000 })
    await page.waitForTimeout(500)
    const r = (await box.boundingBox())!
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    const kinds = (): Promise<{ udid: string; type: string; phase?: string }[]> =>
      app.evaluate(() => (globalThis as { inputs?: [] }).inputs ?? [])
    // 1) ten normal taps.
    for (let i = 0; i < 10; i++) {
      await page.mouse.move(x + i, y)
      await page.mouse.down()
      await page.waitForTimeout(40)
      await page.mouse.up()
      await page.waitForTimeout(60)
    }
    // 2) a cancelled press: down, then a pointercancel, no up.
    await page.mouse.move(x, y + 20)
    await page.mouse.down()
    await page.waitForTimeout(40)
    await box.dispatchEvent('pointercancel', { pointerId: 1 })
    await page.waitForTimeout(80)
    await page.mouse.up().catch(() => {})
    // 3) a press while the agent moves the pane to device B, then release.
    await page.mouse.move(x, y + 40)
    await page.mouse.down()
    await page.waitForTimeout(40)
    await app.evaluate(
      ({ BrowserWindow }, p) => {
        BrowserWindow.getAllWindows()[0].webContents.send('app:open-simulator', p)
      },
      {
        workspaceId: ws,
        chatId: await page.evaluate(() =>
          Object.keys(localStorage)
            .find((k) => k.startsWith('simOpen:'))!
            .slice('simOpen:'.length)
        ),
        udid: B
      }
    )
    await page.waitForTimeout(120)
    await page.mouse.up()
    await page.waitForTimeout(200)
    const ev = await kinds()
    const touches = ev.filter((e) => e.type === 'touch')
    const starts = touches.filter((e) => e.phase === 'start')
    const ends = touches.filter((e) => e.phase === 'end')
    console.log(
      'TOUCHES starts=' + starts.length + ' ends=' + ends.length + ' total=' + touches.length
    )
    // The invariant: a start for every end, an end for every start, in balance.
    expect(ends.length).toBe(starts.length)
    expect(starts.length).toBeGreaterThanOrEqual(11)
    // Never two fingers down at once: the running count of (start - end) over
    // the sequence stays 0 or 1, never 2.
    let down = 0
    let maxDown = 0
    for (const t of touches) {
      if (t.phase === 'start') down++
      if (t.phase === 'end') down--
      maxDown = Math.max(maxDown, down)
    }
    expect(down).toBe(0)
    expect(maxDown).toBeLessThanOrEqual(1)
    // The device-switch press is lifted from the device it went to (A), not B.
    const lastStart = starts[starts.length - 1]
    const lastEnd = ends[ends.length - 1]
    expect(lastStart.udid).toBe(A)
    expect(lastEnd.udid).toBe(A)
  } finally {
    await app.close().catch(() => {})
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
