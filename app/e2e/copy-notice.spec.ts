import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * When a chat in a folder of repos gets its own copy of one of them, the chat
 * says so: which repo, on which branch, and that the rest was left alone.
 */
test('a chat says when it is given its own copy of a repo', async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-cn-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-cn-proj-'))
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
    const chatId = await w.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const ws = tree.flatMap((g) => g.workspaces).find((x) => x.name === 'e2e-project')!
      return window.cove.chatCreate(ws.id)
    })
    await w.click('.sidebar-item:has-text("e2e-project")')
    await w.waitForSelector('textarea.easy-input', { timeout: 20_000 })
    // What main sends the moment a repo is cut (chat-copy.ts copyNotice).
    const text =
      '📂 This chat now has its own copy of `api`, on the branch `add-login`, because it is about to change it. Your checkout is untouched, and the other repos in this folder are not copied. Keep adds its changes back; Throw away discards them.'
    await app.evaluate(
      ({ BrowserWindow }, p) => {
        for (const win of BrowserWindow.getAllWindows()) win.webContents.send('chat:notice', p)
      },
      { chatId, text }
    )
    const line = w.locator('.easy-transcript:visible').getByText('has its own copy of')
    await expect(line).toBeVisible()
    await expect(w.locator('.easy-transcript:visible')).toContainText('Your checkout is untouched')
    // A notice for another chat is not shown here.
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows())
        win.webContents.send('chat:notice', { chatId: 'someone-else', text: 'NOT FOR THIS CHAT' })
    })
    await w.waitForTimeout(300)
    await expect(w.locator('.easy-transcript:visible')).not.toContainText('NOT FOR THIS CHAT')
    if (process.env.SHOT)
      await w.locator('.easy-transcript:visible').screenshot({ path: '/tmp/sa-copy-notice.png' })
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
