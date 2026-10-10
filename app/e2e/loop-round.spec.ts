import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A round of a loop arrives as a message from the user with a paragraph of
 * instructions for the agent on the end. It was shown whole, in the user's
 * own bubble, every round. It is shown as what it is: a round of a loop, with
 * what was asked and none of the instructions.
 */
test('a loop round shows what was asked, marked as a loop, without its instructions', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-loopround-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-loopround-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate((theme) => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
      if (theme) localStorage.setItem('cove.theme', theme)
    }, process.env.THEME ?? '')
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const chatId = await window.cove.chatCreate(wsId)
      const note =
        '\n\n(/loop, self-paced: pick your own pace with the loop_wait tool, exactly as you would call ScheduleWakeup in a terminal. Keep rounds brief. This loop runs until the user stops it.)'
      window.cove.chatSave(
        chatId,
        JSON.stringify([
          { kind: 'msg', msg: { id: 'u0', role: 'user', text: 'typed by hand, an ordinary message' } },
          { kind: 'msg', msg: { id: 'a0', role: 'assistant', text: 'Understood.' } },
          { kind: 'msg', msg: { id: 'u1', role: 'user', text: 'polish everything please' + note } },
          { kind: 'msg', msg: { id: 'a1', role: 'assistant', text: 'One more thing tidied.' } },
          {
            kind: 'msg',
            msg: {
              id: 'u2',
              role: 'user',
              text: 'check the build\n\n(/loop 5m: run sleep as your last action)'
            }
          }
        ])
      )
    })
    await page.reload()
    await page.waitForSelector('.sidebar', { timeout: 20_000 })
    await page.click('.sidebar-item:has-text("e2e-project")')

    const rounds = page.locator('.easy-msg.easy-loop-round:visible')
    await expect(rounds).toHaveCount(2, { timeout: 15_000 })
    await expect(rounds.first()).toContainText('polish everything please')
    await expect(rounds.first().locator('.easy-loop-chip')).toHaveText(/Loop/)
    await expect(rounds.nth(1).locator('.easy-loop-chip')).toContainText('every 5m')
    // None of the instructions, anywhere on screen.
    await expect(page.getByText('pick your own pace')).toHaveCount(0)
    await expect(page.getByText('run sleep as your last action')).toHaveCount(0)
    // They are still there for whoever wants them, on the chip.
    await expect(rounds.first().locator('.easy-loop-chip')).toHaveAttribute('title', /loop_wait/)
    // And a message typed by hand is not dressed as one.
    const typed = page.locator('.easy-msg.easy-user:visible', { hasText: 'typed by hand' })
    await expect(typed).not.toHaveClass(/easy-loop-round/)
    await expect(typed.locator('.easy-loop-chip')).toHaveCount(0)
    if (process.env.SHOT)
      await page.locator('.easy-messages, .easy-scroll').first().screenshot({ path: '/tmp/sa-loop-round.png' }).catch(() => page.screenshot({ path: '/tmp/sa-loop-round.png' }))
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
