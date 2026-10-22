import { test, expect, _electron as electron, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 2026-10-22: dragging a chat (from Pinned or the tree) and moving it around
 * inside the sidebar scrolled the sidebar sideways — the dragged row poked past
 * the edge and the drag library scrolled after it. The sidebar never scrolls
 * sideways now, wherever the row is carried.
 */
test('dragging a row inside the sidebar never scrolls it sideways', async () => {
  test.setTimeout(120_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-side-drag-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-side-dragp-'))
  writeFileSync(join(proj, 'README.md'), '# e2e\n')
  const launch = (): ReturnType<typeof electron.launch> =>
    electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
    })
  let app = await launch()
  try {
    let window: Page = await app.firstWindow()
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      localStorage.setItem('cove.e2e', '1')
    })
    const ids = await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const a = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const out: string[] = []
      for (const title of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
        const id = await window.cove.chatCreate(a)
        await window.cove.chatUpdate(id, { title })
        out.push(id)
      }
      return out
    })
    for (const id of ids.slice(0, 2))
      execFileSync('sqlite3', [
        join(data, 'cove.db'),
        `UPDATE chats SET pinned = 1, pinnedAt = ${Date.now()} WHERE id = '${id}'`
      ])
    await app.close()
    app = await launch()
    window = await app.firstWindow()
    await window.setViewportSize({ width: 1440, height: 900 })
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await expect(window.locator('.sidebar-pinned-shortcuts .activity-row').first()).toBeVisible()
    // Record the most anything in the sidebar was ever scrolled sideways.
    await window.evaluate(() => {
      const w = window as unknown as { sideways: number }
      w.sideways = 0
      document.addEventListener(
        'scroll',
        (e) => {
          const el = (e.target === document ? document.scrollingElement : e.target) as HTMLElement
          w.sideways = Math.max(w.sideways, el.scrollLeft)
        },
        true
      )
    })
    const side = (await window.locator('aside.sidebar').boundingBox())!
    const carry = async (sel: string, text: string): Promise<void> => {
      const row = window.locator(sel, { hasText: text }).first()
      const box = (await row.boundingBox())!
      const y = box.y + box.height / 2
      await window.mouse.move(box.x + 30, y)
      await window.mouse.down()
      await window.mouse.move(box.x + 50, y + 4, { steps: 4 })
      // Hard against the sidebar's right edge, then down the list and back.
      await window.mouse.move(side.x + side.width - 4, y + 10, { steps: 10 })
      await window.mouse.move(side.x + side.width - 2, y + 160, { steps: 10 })
      await window.mouse.move(side.x + side.width - 6, y, { steps: 10 })
      // The row follows up and down, never sideways.
      expect(Math.round((await row.boundingBox())!.x)).toBe(Math.round(box.x))
      await window.mouse.move(side.x + 3, y + 40, { steps: 10 })
      await window.mouse.move(side.x + side.width / 2, y + 400, { steps: 10 })
      await window.waitForTimeout(400)
      await window.mouse.move(box.x + 30, y, { steps: 6 })
      await window.mouse.up()
    }
    await carry('.sidebar-pinned-shortcuts .activity-row', 'Bravo')
    await carry('.sidebar-scroll [data-chat-id]', 'Delta')
    const scrolled = await window.evaluate(() => {
      const els = [...document.querySelectorAll('*')] as HTMLElement[]
      return {
        ever: (window as unknown as { sideways: number }).sideways,
        now: Math.max(0, ...els.map((e) => e.scrollLeft))
      }
    })
    expect(scrolled).toEqual({ ever: 0, now: 0 })
    // And nothing was dropped into a split on the way.
    await expect(window.locator('.workspace-view.in-tile:visible')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
