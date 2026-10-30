import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The settings under the message box, in a narrow chat column: they fold into
 * the agent's logo at the front of the box and open as a list, where they used
 * to wrap into four rows of pills (and then took a line of their own). Wide,
 * the pills are as they were.
 */
test('a narrow chat folds its settings into the logo in the box, which opens them as a list', async () => {
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
    // Not `:visible`: folded, the settings row has no height left at all.
    const controls = w.locator('.workspace-view:visible .easy-controls').first()
    const summary = controls.locator('.easy-controls-summary')
    const logo = w.locator('.easy-input-agent:visible').first()
    const model = controls.locator('.easy-control-btn', { hasText: 'Model' })
    await expect(model).toBeVisible({ timeout: 20_000 })

    // Wide: pills, and no summary line or logo.
    await expect(summary).toBeHidden()
    await expect(w.locator('.easy-input-agent:visible')).toHaveCount(0)
    await expect(controls.locator('.easy-stats')).toBeVisible()

    // Narrow the chat column itself, as dragging the split or the window does.
    await w.evaluate(() => {
      const chat = document.querySelector('.easy-controls')!.closest('.easy-chat') as HTMLElement
      chat.style.maxWidth = '420px'
    })
    // Folded: no line under the box at all, only the logo inside it, which
    // says what the chat is set to when you point at it.
    await expect(summary).toBeHidden()
    await expect(logo).toBeVisible()
    expect(await logo.locator('.easy-input-tip').textContent()).toContain('Claude Code')
    await expect(model).toBeHidden()
    // The typing starts after the logo, not under it.
    const input = w.locator('.easy-input:visible').first()
    expect(
      await input.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft))
    ).toBeGreaterThanOrEqual(34)
    // Nothing else stays out: the token count is in the fold with the rest.
    const stats = controls.locator('.easy-stats')
    await expect(stats).toBeHidden()
    const folded = await controls.evaluate((e) => (e as HTMLElement).offsetHeight)
    expect(folded).toBeLessThan(4)

    // Open: a list, one setting to a row across the column.
    await logo.click()
    await expect(summary).toBeVisible()
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

    // And folds away again (from its header or the logo): the rows close
    // first, then go.
    await summary.click()
    await expect(controls).toHaveClass(/folding/)
    await expect(model).toBeHidden()
    await expect(controls).not.toHaveClass(/folding|unfolded/)
    await expect(stats).toBeHidden()
    expect(await controls.evaluate((e) => (e as HTMLElement).offsetHeight)).toBe(folded)
    // Pressed again while it is closing, it opens straight back up.
    await logo.click()
    await logo.click()
    await logo.click()
    await expect(model).toBeVisible()
    await expect(controls).not.toHaveClass(/folding/)
    await logo.click()
    await expect(model).toBeHidden()
    if (process.env.SHOT)
      await w
        .locator('.easy-input-row:visible')
        .first()
        .screenshot({ path: '/tmp/sa-fold-logo.png' })
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
