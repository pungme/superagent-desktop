import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * A message can be pinned: it shows in a strip over the conversation, the
 * strip takes you to it, it is still pinned after a restart, and it can be
 * unpinned from the strip or the message.
 */
test('a message can be pinned, found again from the strip, and unpinned', async () => {
  test.setTimeout(90_000)
  const data = mkdtempSync(join(tmpdir(), 'cove-pin-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-pin-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const launch = () =>
    electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
    })
  let app = await launch()
  try {
    let window = await app.firstWindow()
    await window.evaluate(() => {
      localStorage.setItem('cove.onboarded', '1')
      localStorage.setItem('cove.connectionsOffered', '1')
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    const chatId = await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const chatId = await window.cove.chatCreate(wsId)
      const items: unknown[] = [
        { kind: 'msg', msg: { id: 'u1', role: 'user', text: 'What is the plan?' } }
      ]
      for (let i = 0; i < 40; i++)
        items.push({
          kind: 'msg',
          msg: {
            id: `a${i}`,
            role: 'assistant',
            text: `Reply number ${i}, with a line of text to give it height.`
          }
        })
      items.push({ kind: 'msg', msg: { id: 'last', role: 'assistant', text: 'The latest reply.' } })
      window.cove.chatSave(chatId, JSON.stringify(items))
      return chatId
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.click('.sidebar-item:has-text("e2e-project")')
    await expect(window.locator('.easy-assistant:visible').last()).toContainText(
      'The latest reply.',
      {
        timeout: 15_000
      }
    )
    // Nothing pinned: no strip.
    await expect(window.locator('.easy-pins')).toHaveCount(0)
    // Pin the latest reply from its rail.
    const last = window.locator('.easy-msg:visible', { hasText: 'The latest reply.' })
    await last.hover()
    await last.getByRole('button', { name: 'Pin message' }).click()
    const strip = window.locator('.easy-pins')
    await expect(strip).toBeVisible()
    await expect(strip).toContainText('Pinned')
    await expect(strip).toContainText('The latest reply.')
    await expect(last.getByRole('button', { name: 'Unpin message' })).toBeVisible()
    // Pin an early one too: the strip counts, and walks.
    await window.evaluate(() => document.querySelector('.easy-scroll')!.scrollTo({ top: 0 }))
    const first = window.locator('.easy-msg:visible', { hasText: 'Reply number 0,' })
    await expect(first).toBeVisible({ timeout: 10_000 })
    await first.hover()
    await first.getByRole('button', { name: 'Pin message' }).click()
    await expect(strip).toContainText('of 2')
    // Saved with the conversation: still there after a restart.
    await app.close()
    app = await launch()
    window = await app.firstWindow()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    await window.click('.sidebar-item:has-text("e2e-project")')
    await expect(window.locator('.easy-pins')).toContainText('of 2', { timeout: 15_000 })
    const saved = await window.evaluate((id) => window.cove.chatLoad(id), chatId)
    expect(
      JSON.parse(saved!).filter((it: { msg?: { pinned?: boolean } }) => it.msg?.pinned)
    ).toHaveLength(2)
    // The strip takes you to the pinned message: scrolled into view and lit.
    await window.evaluate(() => {
      const el = document.querySelector('.easy-scroll')!
      el.scrollTo({ top: el.scrollHeight })
    })
    const jump = window.locator('.easy-pins-jump')
    const shown = (await jump.textContent()) ?? ''
    await jump.click()
    const lit = window.locator('.easy-vrow-found')
    await expect(lit).toHaveCount(1)
    await expect(lit).toContainText(
      shown.includes('Reply number 0') ? 'Reply number 0' : 'The latest reply.'
    )
    // The strip moved on to the other pin.
    await expect(jump).not.toHaveText(shown)
    // Unpin from the strip, twice: no strip, nothing pinned in the save.
    await window.locator('.easy-pins-unpin').click()
    await expect(window.locator('.easy-pins')).toContainText('Pinned')
    await window.locator('.easy-pins-unpin').click()
    await expect(window.locator('.easy-pins')).toHaveCount(0)
    await window.waitForTimeout(1500)
    const after = await window.evaluate((id) => window.cove.chatLoad(id), chatId)
    expect(
      JSON.parse(after!).filter((it: { msg?: { pinned?: boolean } }) => it.msg?.pinned)
    ).toHaveLength(0)
  } finally {
    await app.close().catch(() => {})
    for (const dir of [data, proj]) rmSync(dir, { recursive: true, force: true })
  }
})
