import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Closing a project's conversation asks first. The Chats list always did; a
 * project's own chats went on one click of a small ×.
 */
test("deleting a project's used chat asks, and Cancel keeps it", async () => {
  const data = mkdtempSync(join(tmpdir(), 'cove-del-data-'))
  const proj = mkdtempSync(join(tmpdir(), 'cove-del-proj-'))
  writeFileSync(join(proj, 'README.md'), '# e2e project\n')
  const app = await electron.launch({
    args: [join(__dirname, '..', 'out', 'main', 'index.js')],
    env: { ...process.env, COVE_USER_DATA: data, COVE_E2E_PROJECT: proj, NODE_ENV: 'production' }
  })
  try {
    const window = await app.firstWindow()
    await window.evaluate(() => localStorage.setItem('cove.onboarded', '1'))
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    const ids = await window.evaluate(async () => {
      const tree = await window.cove.storeTree()
      const wsId = tree.flatMap((g) => g.workspaces).find((w) => w.name === 'e2e-project')!.id
      const used = await window.cove.chatCreate(wsId)
      await window.cove.chatUpdate(used, { title: 'Fix the login page' })
      // A third, so the list is still a list after one is deleted: a project
      // with a single conversation shows it on the project's own row.
      const other = await window.cove.chatCreate(wsId)
      await window.cove.chatUpdate(other, { title: 'Write the changelog' })
      const blank = await window.cove.chatCreate(wsId)
      return { wsId, used, blank }
    })
    await window.reload()
    await window.waitForSelector('.sidebar', { timeout: 20_000 })
    const count = (): Promise<number> =>
      window.evaluate(async (ws) => (await window.cove.chatList(ws)).length, ids.wsId)
    // The × on the chat's row in the sidebar, under its project.
    // The × on the chat's row. Sent straight to the button: the row only
    // shows it on hover, and the list may be folded.
    const remove = (title: string): Promise<void> =>
      window
        .locator('.chat-tree-row', { hasText: title })
        .first()
        .locator('.chat-tree-remove')
        .dispatchEvent('click')
    const before = await count()

    // Cancel: asked, by name, and the chat stays.
    const asked: string[] = []
    window.once('dialog', (d) => {
      asked.push(d.message())
      void d.dismiss()
    })
    await remove('Fix the login page')
    await expect.poll(() => asked[0] ?? '').toContain('Delete "Fix the login page"?')
    expect(await count()).toBe(before)

    // An unused New chat goes without a question.
    let surprised = false
    const onDialog = (): void => {
      surprised = true
    }
    window.on('dialog', onDialog)
    await remove('New chat')
    window.off('dialog', onDialog)
    expect(surprised).toBe(false)
    await expect.poll(count).toBe(before - 1)

    // OK deletes it.
    window.once('dialog', (d) => void d.accept())
    await remove('Fix the login page')
    await expect.poll(count).toBe(before - 2)
  } finally {
    await app.close()
    for (const d of [data, proj]) rmSync(d, { recursive: true, force: true })
  }
})
