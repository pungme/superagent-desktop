import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The settings under the message box, in a narrow chat column: they fold into
 * one line and open as a list, where they used to wrap into four rows of
 * pills. Wide, the pills are as they were.
 */
test('a narrow chat folds its settings into one line that opens as a list', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-fold-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-fold-proj-'))
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
      const chatId = await window.cove.chatCreate(ws.id)
      // A reply with its token count, so the row of figures has something in it.
      window.cove.chatSave(
        chatId,
        JSON.stringify([
          {
            kind: 'msg',
            msg: { id: 'a1', role: 'assistant', text: 'Done.', tokens: 90000, tokensNew: 4200 }
          }
        ])
      )
    })
    await w.click('.sidebar-item:has-text("e2e-project")')
    const controls = w.locator('.easy-controls:visible').first()
    const summary = controls.locator('.easy-controls-summary')
    const model = controls.locator('.easy-control-btn', { hasText: 'Model' })
    await expect(model).toBeVisible({ timeout: 20_000 })

    // Wide: pills, and no summary line.
    await expect(summary).toBeHidden()
    await expect(controls.locator('.easy-stats')).toBeVisible()

    // Narrow the chat column itself, as dragging the split or the window does.
    await w.evaluate(() => {
      const chat = document.querySelector('.easy-controls')!.closest('.easy-chat') as HTMLElement
      chat.style.maxWidth = '420px'
    })
    await expect(summary).toBeVisible()
    await expect(summary).toContainText('Claude Code')
    await expect(model).toBeHidden()
    // Nothing else stays out: the token count is in the fold with the rest.
    const stats = controls.locator('.easy-stats')
    await expect(stats).toBeHidden()
    const folded = (await controls.boundingBox())!.height
    expect(folded).toBeLessThan(50)

    // Open: a list, one setting to a row across the column.
    await summary.click()
    await expect(model).toBeVisible()
    // The figures are the last row of the list, across the column like the others.
    await expect(stats).toBeVisible()
    await expect(stats).toContainText('4k tokens')
    const statsBox = (await stats.boundingBox())!
    expect(statsBox.y).toBeGreaterThan((await model.boundingBox())!.y)
    expect(statsBox.width).toBeGreaterThan((await controls.boundingBox())!.width - 40)
    const row = (await model.boundingBox())!
    const box = (await controls.boundingBox())!
    expect(row.width).toBeGreaterThan(box.width - 40)
    if (process.env.SHOT) await controls.screenshot({ path: '/tmp/sa-fold-list.png' })
    // The rows grow into place; once there, nothing is left limiting or
    // clipping them, or a row's menu could not open out of it.
    await expect
      .poll(() =>
        model.evaluate((b) => {
          const row = getComputedStyle(b.closest('.easy-control')!)
          return `${row.maxHeight} ${row.overflow} ${row.opacity}`
        })
      )
      .toBe('none visible 1')
    // A row still opens its menu.
    await model.click()
    await expect(controls.locator('.easy-control-menu')).toBeVisible()
    await model.click()
    await expect(controls.locator('.easy-control-menu')).toHaveCount(0)

    // And folds away again: the rows close first, then go.
    await summary.click()
    await expect(controls).toHaveClass(/folding/)
    await expect(model).toBeHidden()
    await expect(controls).not.toHaveClass(/folding|unfolded/)
    await expect(stats).toBeHidden()
    expect((await controls.boundingBox())!.height).toBe(folded)
    // Pressed again while it is closing, it opens straight back up.
    await summary.click()
    await summary.click()
    await summary.click()
    await expect(model).toBeVisible()
    await expect(controls).not.toHaveClass(/folding/)
    await summary.click()
    await expect(model).toBeHidden()
    if (process.env.SHOT) await controls.screenshot({ path: '/tmp/sa-fold-line.png' })
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
