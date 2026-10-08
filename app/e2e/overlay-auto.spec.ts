import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The browser pane is a native view: it is drawn over all of the window's
 * HTML, whatever z-index says. A tooltip or a menu that reaches over it has to
 * have the pane taken away first, or it opens behind the page. The ones that
 * are not components (a :hover tooltip, a menu wider than its column) never
 * asked for that; the app now notices them itself.
 */
test('a menu that reaches over the browser gets the page out of its way', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-ovl-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-ovl-proj-'))
  writeFileSync(join(proj, 'README.md'), '# x\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const w = await app.firstWindow()
    await w.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await w.reload()
    await w.waitForSelector('.sidebar', { timeout: 20_000 })
    await w.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
      await window.cove.chatCreate(ws.id)
    })
    await w.click('.sidebar-item:has-text("e2e-project")')
    await w.click('.workspace-toolbar:visible .toolbar-btn:has-text("Browser")')
    const address = w.locator('.browser-address:visible').first()
    await expect(address).toBeVisible({ timeout: 10_000 })
    await address.fill('data:text/html,<body style="background:tomato"><h1>page</h1>')
    await address.press('Enter')

    /** The native views on the window: the page is one of them while it shows. */
    const nativeViews = (): Promise<number> =>
      app.evaluate(
        ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.length
      )
    await expect.poll(nativeViews, { timeout: 10_000 }).toBe(1)
    // Painted: a still can only be taken of a page that has drawn.
    await w.waitForTimeout(1500)
    await expect(w.locator('.browser-frozen')).toHaveCount(0)

    // The usage list is wider than the sidebar it opens from, so it lies over
    // the pane beside it.
    await w.locator('.usage-footer-btn').hover()
    const popover = w.locator('.usage-popover')
    await expect(popover).toBeVisible()
    const [pop, host] = await Promise.all([
      popover.boundingBox(),
      w.locator('.browser-host[data-pane-id]').first().boundingBox()
    ])
    expect(pop!.x + pop!.width, 'the list reaches over the pane').toBeGreaterThan(host!.x + 20)

    // So the page steps aside: a still stands in for it, and the view is gone.
    await expect(w.locator('.browser-frozen')).toHaveCount(1)
    await expect.poll(nativeViews).toBe(0)

    // And comes back when the list has closed — the page is never left a photograph.
    await w.mouse.move(900, 300)
    await expect(popover).toHaveCount(0)
    await expect.poll(nativeViews, { timeout: 5_000 }).toBe(1)
    await expect(w.locator('.browser-frozen')).toHaveCount(0)

    // Hovering something that reaches over nothing leaves the page alone.
    await w.locator('.sidebar-settings[title="Settings"]').hover()
    await w.waitForTimeout(600)
    expect(await nativeViews()).toBe(1)
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
